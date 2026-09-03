/**
 * Capability Gate (round-15). Default behavior is READ-ONLY. Every write must
 * pass all of the following gates in order:
 *
 *   1. exact interface matched (transport bound to a precise path / endpoint)
 *   2. Protocol Adapter identified
 *   3. Profile version matched
 *   4. capability explicitly declared (supported / read-only / …)
 *   5. this gate allows the op (policy)
 *   6. payload structure & length validated
 *   7. user policy allows (per device/profile write enablement)
 *   8. write audit record appended
 *
 * Unknown devices, unknown protocols and unknown versions stay at zero writes.
 */

import {
  type CapabilityId,
  type CapabilityMap,
  type CapabilityOp,
  type CapabilityState,
  READ_CAPABILITIES,
} from './model';
import type { WriteAudit } from './audit';

export type WritePolicy = 'read-only' | 'ask' | 'allow';

export interface GateDeviceContext {
  deviceId: string;
  interfaceLabel: string;
  transport: string;
  adapter: string | null | undefined;
  profileId: string | null | undefined;
  profileVersion: string | null | undefined;
  /** exact endpoint path (HID path / serial device / GATT UUID / TCP addr) */
  exactEndpoint: string | null;
  capabilities: CapabilityMap;
  /** user must have enabled writes for this device+profile combo */
  userWriteEnabled: boolean;
}

export interface GateDecision {
  allowed: boolean;
  /** which step blocked the op */
  blockedAt?: number;
  reasons: string[];
  /** ask-policy writes need a human confirmation before execution */
  needsConfirmation?: boolean;
}

const WRITABLE_STATES: CapabilityState[] = ['supported', 'requires-user-profile', 'requires-optional-extension'];

export class CapabilityGate {
  private readonly audit: WriteAudit;
  private policy: WritePolicy;
  /** round-17 §6: emergency kill switch — when ON no write may pass */
  private writesDisabled = true;

  constructor(audit: WriteAudit, policy: WritePolicy = 'read-only') {
    this.audit = audit;
    this.policy = policy;
  }

  setPolicy(p: WritePolicy): void {
    this.policy = p;
  }

  getPolicy(): WritePolicy {
    return this.policy;
  }

  /** master kill switch; default ON (fresh install = read-only) */
  setWritesDisabled(v: boolean): void {
    this.writesDisabled = v;
  }

  getWritesDisabled(): boolean {
    return this.writesDisabled;
  }

  /**
   * Evaluate an op against a device context. The caller (mapping executor)
   * performs the audit recording; the decision carries the full reason trail.
   * `opts.confirmed` is set by the confirmation flow (round-16 P2-6): a
   * previously-issued, still-valid confirmation token authorizes THIS ONE op,
   * skipping only the ask-policy step (all other gates still apply).
   */
  evaluate(op: CapabilityOp, ctx: GateDeviceContext, opts: { confirmed?: boolean } = {}): GateDecision {
    // 1. exact interface matched
    if (!ctx.exactEndpoint) {
      return this.deny(1, ['no exact interface/endpoint matched — refusing to blind-open']);
    }
    // 2. adapter identified
    if (!ctx.adapter) {
      return this.deny(2, ['no Protocol Adapter identified for this device']);
    }
    // 3. profile matched (profile id + version present)
    if (!ctx.profileId || !ctx.profileVersion) {
      return this.deny(3, ['no verified Profile matched (profileId/profileVersion missing)']);
    }

    const capId = op.kind as CapabilityId;
    const state = ctx.capabilities[capId] ?? 'unknown';

    // 4. capability explicitly declared
    if (state === 'unsupported') {
      return this.deny(4, [`capability "${capId}" is declared unsupported by ${ctx.profileId}`]);
    }
    if (state === 'unknown') {
      return this.deny(4, [`capability "${capId}" is unknown for ${ctx.profileId} — never guessed as supported`]);
    }

    // 4.5 master kill switch (round-17 §6): "Disable all writes" is ON by
    // default; it overrides every other policy
    if (this.writesDisabled && !op.readOnly && !READ_CAPABILITIES.has(capId)) {
      return this.deny(5, ['"Disable all writes" master switch is ON (default) — turn it off in Settings to allow any write']);
    }
    // 5. gate policy
    if (this.policy === 'read-only' && !op.readOnly && !READ_CAPABILITIES.has(capId)) {
      return this.deny(5, ['write policy is read-only (default); enable writes in Settings for this device/profile']);
    }
    if (this.policy === 'ask' && !opts.confirmed && !op.readOnly && !READ_CAPABILITIES.has(capId)) {
      return {
        allowed: false,
        blockedAt: 5,
        needsConfirmation: true,
        reasons: ['write policy is ask — a one-time human confirmation is required for this op'],
      };
    }

    // 6. payload validated (structure + length) — payloads are validated by
    //    the adapter's declared validator; here we enforce the minimal contract
    const payloadErr = validatePayload(op);
    if (payloadErr) {
      return this.deny(6, [`payload validation failed: ${payloadErr}`]);
    }

    // 7. user policy allows
    if (WRITABLE_STATES.includes(state) && !op.readOnly) {
      if (!ctx.userWriteEnabled) {
        return this.deny(7, ['user policy does not allow writes for this device/profile yet']);
      }
    }

    // 8. audit is recorded by the executor on the actual write attempt
    return { allowed: true, reasons: ['all gates passed'] };
  }

  private deny(blockedAt: number, reasons: string[]): GateDecision {
    return { allowed: false, blockedAt, reasons };
  }
}

export function validatePayload(op: CapabilityOp): string | null {
  const p = op.payload as Record<string, unknown> | null | undefined;
  switch (op.kind) {
    case 'set-indicator': {
      if (!p || typeof p !== 'object') return 'indicator payload must be an object';
      const color = p.color as { r?: number; g?: number; b?: number } | undefined;
      if (!color || ![color.r, color.g, color.b].every((c) => typeof c === 'number' && c >= 0 && c <= 255)) {
        return 'indicator color must be {r,g,b} in 0..255';
      }
      return null;
    }
    case 'set-rgb':
    case 'set-rgb-matrix':
    case 'set-backlight': {
      if (!p || typeof p !== 'object') return `${op.kind} payload must be an object`;
      const color = p.color as { r?: number; g?: number; b?: number } | undefined;
      if (color && ![color.r, color.g, color.b].every((c) => typeof c === 'number' && c >= 0 && c <= 255)) {
        return `${op.kind} color must be {r,g,b} in 0..255`;
      }
      if (p.mode !== undefined && typeof p.mode !== 'string') return `${op.kind} mode must be a string`;
      return null;
    }
    case 'display-text': {
      if (!p || typeof p !== 'object') return 'display-text payload must be an object';
      if (typeof p.text !== 'string' || p.text.length > 256) return 'display-text text must be a string ≤ 256 chars';
      return null;
    }
    case 'display-icon': {
      if (!p || typeof p !== 'object') return 'display-icon payload must be an object';
      if (typeof p.icon !== 'string' || p.icon.length > 64) return 'display-icon icon must be a string ≤ 64 chars';
      return null;
    }
    case 'haptic': {
      if (!p || typeof p !== 'object') return 'haptic payload must be an object';
      if (typeof p.pattern !== 'string') return 'haptic pattern must be a string';
      return null;
    }
    case 'runtime-keymap': {
      if (!p || typeof p !== 'object') return 'runtime-keymap payload must be an object';
      return null;
    }
    case 'approval-input':
    case 'profile-switch': {
      if (!p || typeof p !== 'object') return `${op.kind} payload must be an object`;
      return null;
    }
    default:
      return `unknown op kind ${(op as { kind: string }).kind}`;
  }
}
