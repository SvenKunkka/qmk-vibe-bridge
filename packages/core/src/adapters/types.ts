/**
 * Protocol Adapter interface (round-15). Each adapter independently:
 *   - identifies the protocol on a matched interface (using ONLY the
 *     protocol's own handshake, and only when the profile matched first);
 *   - declares capabilities (never fakes unsupported as supported);
 *   - encodes/decodes data;
 *   - validates payloads before writing;
 *   - handles errors and lifecycle.
 *
 * No adapter is a global connection gate for any other device. Connection
 * state is maintained per adapter instance (per device).
 */

import type { CapabilityMap, CapabilityOp } from '../capabilities/model';
import type { DeviceTransport } from '../transports/types';
import type { ProtocolProfile } from '../profiles/types';

export interface AdapterContext {
  transport: DeviceTransport;
  profile: ProtocolProfile;
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface IdentifyResult {
  /** 'identified': a real control protocol handshake succeeded.
   *  'transport-only': the transport is usable but declares NO control
   *     capabilities (bare QMK Raw HID) — never shown as protocol-identified.
   *  'unknown' / 'error': identification failed (read-only). */
  status: 'identified' | 'transport-only' | 'unknown' | 'error';
  error?: string;
  capabilities: CapabilityMap;
  /** protocol version observed on the wire, when known */
  observedVersion?: string;
}

/** round-17 §9.3: distinct operation outcomes */
export type OpOutcome =
  | 'blocked'
  | 'needs-confirmation'
  | 'needs-physical-action'
  | 'sent-unverified'
  | 'applied'
  | 'failed'
  | 'disconnected';

export interface OpResult {
  ok: boolean;
  error?: string;
  /** true when bytes actually reached the transport */
  wrote: boolean;
  bytes?: number;
  /** explicit outcome — the UI must never show "applied" without readback
   *  verification; a write without readback is 'sent-unverified' */
  result?: OpOutcome;
  /** true when the op is waiting on a physical action on the device
   *  (e.g. ZMK Studio unlock is performed on the keyboard, not via RPC) */
  needsPhysicalUnlock?: boolean;
}

export interface ProtocolAdapter {
  readonly id: string;
  readonly profileId: string;
  /**
   * Identification may require the interface to be pre-matched (user
   * assigned or registry matched) — the DeviceManager enforces this.
   */
  identify(ctx: AdapterContext): Promise<IdentifyResult>;
  /** execute a gate-approved op */
  apply(op: CapabilityOp, ctx: AdapterContext): Promise<OpResult>;
  close(): Promise<void>;
}
