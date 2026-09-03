/**
 * DeviceManager (round-15 rewrite). Owns the lifecycle of every enumerated
 * interface:
 *
 *   enumerate -> hardware-detected
 *     -> transport-available (openable by exact path; profile matched)
 *     -> protocol-identified / capabilities-known (adapter handshake)
 *     -> limited | ready
 *   terminal: unsupported | permission-denied | disconnected | error
 *
 * Hard rules:
 *   - never open without an exact endpoint path;
 *   - never write before a profile is matched AND the Capability Gate allows;
 *   - never fall back to another HID interface when one fails;
 *   - multi-interface keyboards are handled per interface, never by VID/PID;
 *   - per-adapter connection state (each device has ONE adapter).
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import type { CapabilityMap, CapabilityOp } from '../capabilities/model';
import { UNKNOWN_CAPABILITIES } from '../capabilities/model';
import type { WriteAudit } from '../capabilities/audit';
import { CapabilityGate, type GateDecision, type GateDeviceContext } from '../capabilities/gate';
import type { ProfileMatch, InterfaceDescriptor, ProfileRegistry } from '../profiles/registry';
import type { ProtocolAdapter } from '../adapters/types';
import { createAdapter } from '../adapters/factory';
import type { DeviceTransport, TransportCandidate } from '../transports/types';
import { QMK_RAW_HID_PAGE, QMK_RAW_HID_USAGE } from '../profiles/builtin';
import { ZMK_STUDIO_BLE_SERVICE_UUID as ZMK_STUDIO_GATT_SERVICE_UUID } from '../transports/ble';
import type { DeviceStatus } from './states';
import { statusAllowsWrite } from './states';

export interface DeviceView {
  id: string;
  label: string;
  iface: InterfaceDescriptor;
  status: DeviceStatus;
  transport?: string;
  adapterId?: string;
  profileId?: string | null;
  profileVersion?: string | null;
  capabilities: CapabilityMap | null;
  capabilitiesKnown: boolean;
  matchedProfiles: Array<{ profileId: string; matchedBy: string }>;
  error?: string;
  writeCount: number;
  lastSeen: number;
}

export type DeviceManagerEvent =
  | { type: 'refresh'; devices: DeviceView[] }
  | { type: 'status'; device: DeviceView }
  | { type: 'op'; device: DeviceView; op: CapabilityOp; result: { ok: boolean; error?: string; outcome?: string } }
  | { type: 'removed'; id: string };

export interface DeviceManagerOptions {
  registry: ProfileRegistry;
  audit: WriteAudit;
  gate: CapabilityGate;
  /** platform enumerators (hid / serial / ble / tcp) injected by the app layer */
  enumerators?: Array<(registry: ProfileRegistry) => Promise<TransportCandidate[]>>;
  /** open a transport for a candidate — app layer injects platform opens */
  openTransport?: (candidate: TransportCandidate) => Promise<DeviceTransport>;
  /** ask-policy confirmation token lifetime (ms); default 60s */
  confirmationTtlMs?: number;
  onEvent?: (ev: DeviceManagerEvent) => void;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** result of an ask-policy op awaiting human confirmation */
export interface ConfirmationRequired {
  ok: false;
  needsConfirmation: true;
  confirmationToken: string;
  summary: {
    deviceId: string;
    interfaceLabel: string;
    transport: string;
    adapter: string | null | undefined;
    profileId: string | null | undefined;
    capability: string;
    opLabel: string;
    /** stable hash of the payload — confirmation is bound to it */
    payloadHash: string;
  };
  error: string;
}

interface PendingConfirmation {
  token: string;
  op: CapabilityOp;
  payloadHash: string;
  ctx: GateDeviceContext;
  expiresAt: number;
  consumed: boolean;
}

interface DeviceRecord {
  view: DeviceView;
  transport: DeviceTransport | null;
  adapter: ProtocolAdapter | null;
  userWriteEnabled: boolean;
}

export class DeviceManager {
  private readonly records = new Map<string, DeviceRecord>();
  private readonly opts: Required<Pick<DeviceManagerOptions, 'onEvent' | 'onLog'>> & DeviceManagerOptions;
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  private readonly confirmationTtlMs: number;
  /** round-16 (P2-7): only control-relevant interfaces enter the default list */
  private showAllInterfaces = false;
  private explicitInterfaces = new Set<string>();

  constructor(opts: DeviceManagerOptions) {
    this.opts = { onEvent: opts.onEvent ?? (() => {}), onLog: opts.onLog ?? (() => {}), ...opts };
    this.confirmationTtlMs = opts.confirmationTtlMs ?? 60_000;
  }

  /** Diagnostic switch: enumerate every HID interface (default off). */
  setShowAllInterfaces(v: boolean): void {
    this.showAllInterfaces = v;
    this.opts.onLog('info', `[devices] show-all-interfaces ${v ? 'ON (diagnostic)' : 'OFF'}`);
  }

  get isShowAllInterfaces(): boolean {
    return this.showAllInterfaces;
  }

  /** User explicitly added an interface to the control list. */
  addExplicitInterface(id: string): void {
    this.explicitInterfaces.add(id);
  }

  /**
   * round-16 (P2-7): a candidate enters the DEFAULT control list only when it
   * is control-relevant: strict QMK Raw HID (0xFF60/0x61), ZMK Studio GATT,
   * CDC-ACM serial, TCP simulator, or user-explicit. Ordinary keyboard/mouse/
   * media/system HID interfaces stay out unless "show all" is enabled.
   */
  isControlCandidate(c: TransportCandidate): boolean {
    if (this.showAllInterfaces) return true;
    if (this.explicitInterfaces.has(c.id)) return true;
    if (c.kind === 'tcp') return true;
    if (c.kind === 'serial') return true; // ZMK Studio CDC-ACM
    if (c.kind === 'ble') {
      return (c.serviceUuids ?? []).includes(ZMK_STUDIO_GATT_SERVICE_UUID);
    }
    if (c.kind === 'hid') {
      return c.usagePage === QMK_RAW_HID_PAGE && c.usageId === QMK_RAW_HID_USAGE;
    }
    return false;
  }

  list(): DeviceView[] {
    return [...this.records.values()].map((r) => ({ ...r.view, capabilities: r.view.capabilities ? { ...r.view.capabilities } : null }));
  }

  get(id: string): DeviceView | undefined {
    const r = this.records.get(id);
    return r ? { ...r.view, capabilities: r.view.capabilities ? { ...r.view.capabilities } : null } : undefined;
  }

  /** Enable/disable writes for a device (user policy, Settings UI). */
  setUserWriteEnabled(id: string, enabled: boolean): void {
    const r = this.records.get(id);
    if (r) {
      r.userWriteEnabled = enabled;
      this.opts.onLog('info', `[devices] user write policy for ${id}: ${enabled ? 'enabled' : 'read-only'}`);
    }
  }

  /** Enumerate interfaces and register them as hardware-detected. */
  async refresh(): Promise<DeviceView[]> {
    const enumerators = this.opts.enumerators ?? [];
    const candidates: TransportCandidate[] = [];
    for (const en of enumerators) {
      try {
        candidates.push(...(await en(this.opts.registry)));
      } catch (err) {
        this.opts.onLog('error', `[devices] enumerator failed: ${(err as Error).message}`);
      }
    }
    const seen = new Set<string>();
    let filtered = 0;
    for (const c of candidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (!this.isControlCandidate(c)) {
        filtered += 1;
        continue;
      }
      this.registerCandidate(c);
    }
    if (filtered > 0 && !this.showAllInterfaces) {
      this.opts.onLog('info', `[devices] filtered ${filtered} non-control interface(s); enable "show all" (diagnostic) to list them`);
    }
    this.opts.onEvent({ type: 'refresh', devices: this.list() });
    return this.list();
  }

  /** Register an interface candidate (public so the app layer can add devices). */
  registerCandidate(c: TransportCandidate): void {
    if (this.records.has(c.id)) return;
    const iface: InterfaceDescriptor = {
      path: c.path,
      vendorId: c.vendorId,
      productId: c.productId,
      usagePage: c.usagePage,
      usageId: c.usageId,
      kind: c.kind,
      serviceUuids: c.serviceUuids,
      label: c.label,
    };
    const { matches } = this.opts.registry.match(iface);
    const record: DeviceRecord = {
      view: {
        id: c.id,
        label: c.label,
        iface,
        status: 'hardware-detected',
        capabilities: null,
        capabilitiesKnown: false,
        matchedProfiles: matches.map((m: ProfileMatch) => ({ profileId: m.profile.profileId, matchedBy: m.matchedBy })),
        writeCount: 0,
        lastSeen: Date.now(),
      },
      transport: null,
      adapter: null,
      userWriteEnabled: false,
    };
    this.records.set(c.id, record);
    this.opts.onLog('info', `[devices] detected ${c.label} (${c.kind}${c.path ? ` @ ${c.path}` : ' — no path'})`);
    this.updateStatus(record, this.initialStatus(record));
  }

  private initialStatus(record: DeviceRecord): DeviceStatus {
    const iface = record.view.iface;
    // no exact path: can never be opened — hardware-detected only
    if (!iface.path) return 'hardware-detected';
    // a path-bearing interface that matches NO control profile is
    // transport-available with unknown capabilities — never "unsupported"
    // (round-15: unknown devices stay read-only, zero writes)
    if (record.view.matchedProfiles.length === 0) return 'transport-available';
    const hasQmk = record.view.matchedProfiles.some((m) => m.profileId === 'qmk-rawhid');
    const hasOthers = record.view.matchedProfiles.some((m) => m.profileId !== 'qmk-rawhid');
    if (hasQmk && !hasOthers) return 'transport-available';
    return 'transport-available';
  }

  /**
   * Connect an interface: open its transport by exact path and run the chosen
   * adapter's identification. If no specific profile was requested, the
   * highest-precedence matched profile is used (user-assigned > gatt > vidpid
   * > qmk-rawhid).
   */
  async connect(id: string, requestedProfileId?: string): Promise<DeviceView> {
    const record = this.records.get(id);
    if (!record) throw new Error(`device ${id} not found`);
    const iface = record.view.iface;
    if (!iface.path) {
      this.updateStatus(record, 'unsupported', 'no exact interface path — cannot open');
      return record.view;
    }
    if (!this.opts.openTransport) {
      this.updateStatus(record, 'error', 'no transport opener configured');
      return record.view;
    }

    // pick the adapter/profile (deterministic priority, round-17)
    const { matches, ambiguous } = this.opts.registry.match(iface);
    let match: ProfileMatch | undefined;
    if (requestedProfileId) {
      match = matches.find((m) => m.profile.profileId === requestedProfileId);
      if (!match) {
        // user requested a profile explicitly: allow a user-assigned match
        const assigned = this.opts.registry.get(requestedProfileId);
        if (assigned) {
          match = { profile: assigned, matchedBy: 'user-assigned' as const, rank: 2 };
        }
      }
      if (!match) {
        this.updateStatus(record, 'unsupported', `profile "${requestedProfileId}" cannot be used on this interface`);
        return record.view;
      }
    } else if (ambiguous) {
      // ambiguity at the top rank: stay read-only, require user choice
      const top = matches.filter((m) => m.rank === matches[0]?.rank);
      this.updateStatus(
        record,
        'transport-available',
        `Ambiguous protocol match (${top.map((m) => m.profile.profileId).join(', ')}) — select a profile explicitly; the device remains read-only`,
      );
      return record.view;
    } else {
      match = matches[0];
    }
    if (!match) {
      // raw HID-looking interface without any profile -> transport-available, read-only
      this.updateStatus(record, 'transport-available', 'No verified control profile is selected. The device will remain read-only.');
      return record.view;
    }
    const profile = match.profile;

    // open transport by exact path
    let transport: DeviceTransport;
    try {
      const candidate: TransportCandidate = {
        id: iface.path,
        label: iface.label,
        kind: iface.kind as TransportCandidate['kind'],
        path: iface.path,
        vendorId: iface.vendorId,
        productId: iface.productId,
        usagePage: iface.usagePage,
        usageId: iface.usageId,
        serviceUuids: iface.serviceUuids,
      };
      transport = await this.opts.openTransport(candidate);
      await transport.open();
    } catch (err) {
      const e = err as Error;
      if (isPermissionError(e.message)) {
        this.updateStatus(record, 'permission-denied', e.message);
      } else {
        this.updateStatus(record, 'error', e.message);
      }
      return record.view;
    }
    record.transport = transport;
    record.view.transport = profile.transport[0] ?? iface.kind;

    // instantiate the adapter (per-device, independent lifecycle)
    const adapter = createAdapter(profile.profileId);
    record.adapter = adapter;
    record.view.adapterId = adapter.id;
    record.view.profileId = profile.profileId;
    record.view.profileVersion = profile.protocolVersion;
    this.updateStatus(record, 'transport-available', undefined);

    // run identification (protocol-defined handshake only; qmk-rawhid probes nothing)
    const ctx = {
      transport,
      profile,
      onLog: (l: 'info' | 'warn' | 'error', m: string) => this.opts.onLog(l, `[${id}] ${m}`),
    };
    const result = await adapter.identify(ctx);
    record.view.profileVersion = result.observedVersion ?? profile.protocolVersion;
    if (result.status === 'identified') {
      record.view.capabilities = { ...result.capabilities };
      record.view.capabilitiesKnown = true;
      record.view.error = undefined;
      this.updateStatus(record, this.computeReadiness(record));
      this.opts.onLog('info', `[${id}] protocol identified: ${profile.profileId} (${record.view.profileVersion})`);
    } else if (result.status === 'transport-only') {
      // round-16 (P1-2): bare QMK Raw HID — the transport is usable but there
      // is NO control protocol. capabilitiesKnown stays FALSE; the UI must
      // NOT show "protocol identified" / "capabilities known", only the
      // read-only banner. Zero writes throughout.
      record.view.capabilities = { ...result.capabilities };
      record.view.capabilitiesKnown = false;
      record.view.error = result.error;
      this.updateStatus(record, 'transport-available', result.error ?? 'QMK Raw HID transport found. No verified control profile is selected. The device will remain read-only.');
      this.opts.onLog('info', `[${id}] transport-only (${profile.profileId}) — no control profile, read-only`);
    } else {
      record.view.capabilities = { ...profile.capabilities };
      record.view.capabilitiesKnown = false;
      record.view.error = result.error;
      // identification failed: never a terminal "incompatible" — keep it at
      // transport-available with the read-only explanation
      this.updateStatus(record, 'transport-available', result.error ?? 'protocol not identified — device remains read-only');
    }
    return { ...record.view };
  }

  private computeReadiness(record: DeviceRecord): DeviceStatus {
    const caps = record.view.capabilities;
    if (!caps) return 'transport-available';
    const states = Object.values(caps);
    const anySupported = states.includes('supported');
    if (anySupported) return 'ready';
    if (states.includes('requires-user-profile') || states.includes('requires-optional-extension')) return 'limited';
    return 'capabilities-known';
  }

  async disconnect(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (record.adapter) {
      await record.adapter.close().catch(() => {});
      record.adapter = null;
    }
    if (record.transport) {
      await record.transport.close().catch(() => {});
      record.transport = null;
    }
    this.updateStatus(record, 'disconnected', undefined);
  }

  /**
   * Execute a capability op on a device: gate first, then adapter. Every
   * attempt is audited; writes that reach the transport increment the
   * device write counter.
   */
  async applyOp(op: CapabilityOp): Promise<{ ok: boolean; error?: string }> {
    const record = this.records.get(op.deviceId);
    if (!record) {
      return { ok: false, error: `device ${op.deviceId} not found` };
    }
    const caps = record.view.capabilities ?? { ...UNKNOWN_CAPABILITIES };
    const decision = this.opts.gate.evaluate(op, {
      deviceId: op.deviceId,
      interfaceLabel: record.view.iface.label,
      transport: record.view.transport ?? record.view.iface.kind,
      adapter: record.view.adapterId,
      profileId: record.view.profileId,
      profileVersion: record.view.profileVersion,
      exactEndpoint: record.view.iface.path ?? null,
      capabilities: caps,
      userWriteEnabled: record.userWriteEnabled,
    });

    if (!decision.allowed) {
      // round-16 (P2-6): ask-policy writes require a one-time human confirmation
      if (decision.needsConfirmation) {
        const summary = {
          deviceId: op.deviceId,
          interfaceLabel: record.view.iface.label,
          transport: record.view.transport ?? record.view.iface.kind,
          adapter: record.view.adapterId,
          profileId: record.view.profileId,
          capability: op.kind,
          opLabel: op.label,
          payloadHash: stableHash(op.payload),
        };
        const token = crypto.randomBytes(16).toString('hex');
        this.pendingConfirmations.set(token, {
          token,
          op,
          payloadHash: summary.payloadHash,
          ctx: {
            deviceId: op.deviceId,
            interfaceLabel: record.view.iface.label,
            transport: record.view.transport ?? record.view.iface.kind,
            adapter: record.view.adapterId,
            profileId: record.view.profileId,
            profileVersion: record.view.profileVersion,
            exactEndpoint: record.view.iface.path ?? null,
            capabilities: caps,
            userWriteEnabled: record.userWriteEnabled,
          },
          expiresAt: Date.now() + this.confirmationTtlMs,
          consumed: false,
        });
        this.opts.audit.record({
          deviceId: op.deviceId,
          interfaceLabel: record.view.iface.label,
          transport: record.view.transport ?? record.view.iface.kind,
          adapter: record.view.adapterId,
          profileId: record.view.profileId,
          capability: op.kind,
          opLabel: op.label,
          wrote: false,
          allowed: false,
          reasons: ['ask policy: awaiting one-time human confirmation'],
        });
        this.opts.onLog('info', `[${op.deviceId}] op ${op.kind} awaits confirmation (token ${token.slice(0, 8)}…)`);
        const result: ConfirmationRequired = {
          ok: false,
          needsConfirmation: true,
          confirmationToken: token,
          summary,
          error: 'confirmation required (ask policy)',
        };
        return result;
      }
      this.opts.audit.record({
        deviceId: op.deviceId,
        interfaceLabel: record.view.iface.label,
        transport: record.view.transport ?? record.view.iface.kind,
        adapter: record.view.adapterId,
        profileId: record.view.profileId,
        capability: op.kind,
        opLabel: op.label,
        wrote: false,
        allowed: false,
        reasons: decision.reasons,
      });
      this.opts.onLog('warn', `[${op.deviceId}] op ${op.kind} blocked: ${decision.reasons.join('; ')}`);
      return { ok: false, error: decision.reasons.join('; ') };
    }

    return this.executeOp(record, op, decision);
  }

  /** Shared adapter execution: audit + write-count + event fan-out. */
  private async executeOp(
    record: DeviceRecord,
    op: CapabilityOp,
    decision: GateDecision,
  ): Promise<{ ok: boolean; error?: string; outcome?: string }> {
    if (!record.adapter) {
      this.opts.audit.record({
        deviceId: op.deviceId,
        interfaceLabel: record.view.iface.label,
        transport: record.view.transport ?? record.view.iface.kind,
        adapter: null,
        profileId: record.view.profileId,
        capability: op.kind,
        opLabel: op.label,
        wrote: false,
        allowed: false,
        reasons: ['no adapter attached'],
      });
      return { ok: false, error: 'no adapter attached' };
    }

    const result = await record.adapter.apply(op, {
      transport: record.transport!,
      profile: this.opts.registry.get(record.view.profileId ?? '')!,
      onLog: (l, m) => this.opts.onLog(l, `[${op.deviceId}] ${m}`),
    });
    const outcome = result.result ?? (result.ok ? (result.wrote ? 'sent-unverified' : 'applied') : 'failed');
    if (result.wrote) {
      record.view.writeCount += 1;
    }
    this.opts.audit.record({
      deviceId: op.deviceId,
      interfaceLabel: record.view.iface.label,
      transport: record.view.transport ?? record.view.iface.kind,
      adapter: record.view.adapterId,
      profileId: record.view.profileId,
      capability: op.kind,
      opLabel: op.label,
      wrote: result.wrote,
      allowed: result.ok,
      reasons: decision.reasons,
      error: result.error,
      outcome,
    });
    this.opts.onEvent({ type: 'op', device: { ...record.view }, op, result: { ok: result.ok, error: result.error, outcome } });
    return { ok: result.ok, error: result.error, outcome };
  }

  /**
   * Confirm an ask-policy op (round-16 P2-6). The token is one-time, expires,
   * and is bound to the device/profile/op/payload hash — a different payload
   * at confirm time is rejected. Returns the execution result.
   */
  async confirmOp(token: string, op?: CapabilityOp): Promise<{ ok: boolean; error?: string; outcome?: string }> {
    const pending = this.pendingConfirmations.get(token);
    if (!pending) {
      return { ok: false, error: 'unknown or already-consumed confirmation token' };
    }
    if (pending.consumed) {
      return { ok: false, error: 'confirmation token already consumed (one-time)' };
    }
    if (Date.now() > pending.expiresAt) {
      this.pendingConfirmations.delete(token);
      return { ok: false, error: 'confirmation token expired' };
    }
    if (op && stableHash(op.payload) !== pending.payloadHash) {
      return { ok: false, error: 'confirmation payload mismatch — the operation changed, re-request it' };
    }
    if (op && (op.kind !== pending.op.kind || op.deviceId !== pending.op.deviceId)) {
      return { ok: false, error: 'confirmation target mismatch — the operation changed, re-request it' };
    }
    pending.consumed = true;
    this.pendingConfirmations.delete(token);
    // re-run the gate with the confirmed bypass (all other gates still apply),
    // then execute DIRECTLY — never re-enter the ask path
    const decision = this.opts.gate.evaluate(pending.op, pending.ctx, { confirmed: true });
    if (!decision.allowed) {
      this.opts.audit.record({
        deviceId: pending.op.deviceId,
        interfaceLabel: pending.ctx.interfaceLabel,
        transport: pending.ctx.transport,
        adapter: pending.ctx.adapter,
        profileId: pending.ctx.profileId,
        capability: pending.op.kind,
        opLabel: pending.op.label,
        wrote: false,
        allowed: false,
        reasons: decision.reasons,
      });
      return { ok: false, error: decision.reasons.join('; ') };
    }
    const record = this.records.get(pending.op.deviceId);
    if (!record) return { ok: false, error: 'device gone before confirmation' };
    return this.executeOp(record, pending.op, decision);
  }

  /** list pending confirmations (UI panel) */
  pendingConfirmationsList(): Array<{ token: string; summary: ConfirmationRequired['summary']; expiresAt: number }> {
    return [...this.pendingConfirmations.values()].map((p) => ({
      token: p.token,
      summary: {
        deviceId: p.op.deviceId,
        interfaceLabel: p.ctx.interfaceLabel,
        transport: p.ctx.transport,
        adapter: p.ctx.adapter,
        profileId: p.ctx.profileId,
        capability: p.op.kind,
        opLabel: p.op.label,
        payloadHash: p.payloadHash,
      },
      expiresAt: p.expiresAt,
    }));
  }

  remove(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    if (record.adapter) void record.adapter.close().catch(() => {});
    if (record.transport) void record.transport.close().catch(() => {});
    this.records.delete(id);
    this.opts.onEvent({ type: 'removed', id });
  }

  clear(): void {
    for (const id of [...this.records.keys()]) this.remove(id);
  }

  /** total writes across devices (audit is authoritative; this is a fast path) */
  totalWrites(): number {
    return this.opts.audit.countWrites();
  }

  private updateStatus(record: DeviceRecord, status: DeviceStatus, error?: string): void {
    record.view.status = status;
    if (error !== undefined) record.view.error = error;
    record.view.lastSeen = Date.now();
    this.opts.onEvent({ type: 'status', device: { ...record.view } });
  }
}

export function stableHash(payload: unknown): string {
  const raw = JSON.stringify(payload ?? null);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function isPermissionError(message: string): boolean {
  return /permission|denied|privilege|not permitted|kUTType|kIOReturnNotPermitted|0xE00002C1/i.test(message);
}

export function isWriteAllowedByStatus(status: DeviceStatus): boolean {
  return statusAllowsWrite(status);
}
