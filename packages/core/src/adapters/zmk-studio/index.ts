/**
 * ZMK Studio adapter (round-16). Implements the official ZMK Studio RPC
 * protocol over USB CDC-ACM serial or BLE GATT:
 *   - protobuf messages (zmk-studio-messages)
 *   - official framing (SoF 0xAB / Esc 0xAC / EoF 0xAD)
 *   - Request / Response / Notification lifecycle
 *   - lock state handling per the official core.proto:
 *       core.Request = { get_device_info=1, get_lock_state=2, lock=3,
 *                        reset_settings=4 }  — there is NO unlock RPC.
 *     Unlock is a PHYSICAL action on the keyboard; the firmware notifies the
 *     host with core.Notification.lock_state_changed. The adapter therefore:
 *       - never sends an "unlock" RPC (zero writes for unlock);
 *       - tracks lock state from notifications + get_lock_state polling;
 *       - sends core.lock ONLY on an explicit lock request;
 *       - reports needsPhysicalUnlock while waiting for the physical unlock.
 *   - timeouts, disconnects and permission handling
 *
 * Honest capability split (per round-15/16):
 *   - Studio RPC exposes runtime KEYMAP configuration (supported, unlocked).
 *   - Studio RPC does NOT expose RGB / OLED / haptics / key-event streams
 *     (declared unsupported — never simulated).
 * If the keyboard firmware does not enable ZMK Studio, identification fails
 * and the UI shows "Studio endpoint unavailable / feature not enabled in
 * current keyboard firmware".
 */

import type { CapabilityOp, CapabilityId } from '../../capabilities/model';
import type { AdapterContext, IdentifyResult, OpResult, ProtocolAdapter } from '../types';
import { ZmkFrameStream, zmkFrameEncode } from './framing';
import {
  decodeStudioResponse, encodeStudioRequest,
  type StudioRequest, type StudioResponse,
} from './messages';
import { ZMK_STUDIO_BLE_SERVICE_UUID, ZMK_STUDIO_BLE_CHARACTERISTIC_UUID } from '../../transports/ble';

export const ZMK_STUDIO_ADAPTER_ID = 'zmk-studio';

export { ZMK_STUDIO_BLE_SERVICE_UUID, ZMK_STUDIO_BLE_CHARACTERISTIC_UUID };

export type StudioLockState = 'locked' | 'unlocked' | 'unknown';

export interface ZmkStudioAdapterOptions {
  /** how long to wait for a response (ms) */
  timeoutMs?: number;
}

export class ZmkStudioAdapter implements ProtocolAdapter {
  readonly id = ZMK_STUDIO_ADAPTER_ID;
  readonly profileId = 'zmk-studio';

  /** capabilities with a real handler in apply()/notification path */
  static readonly implementedCapabilities: CapabilityId[] = ['runtime-keymap'];

  private readonly timeoutMs: number;
  private stream = new ZmkFrameStream();
  private waiters: Map<number, { resolve: (r: StudioResponse | null) => void; timer: NodeJS.Timeout }> = new Map();
  private nextRequestId = 1;
  private attached = false;
  private lockState: StudioLockState = 'unknown';
  private lockListeners = new Set<(s: StudioLockState) => void>();

  constructor(opts: ZmkStudioAdapterOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 2000;
  }

  get currentLockState(): StudioLockState {
    return this.lockState;
  }

  /** notified whenever the lock state changes (notification or poll) */
  onLockStateChange(cb: (s: StudioLockState) => void): () => void {
    this.lockListeners.add(cb);
    return () => this.lockListeners.delete(cb);
  }

  private setLockState(s: StudioLockState): void {
    if (this.lockState === s) return;
    this.lockState = s;
    for (const cb of this.lockListeners) {
      try {
        cb(s);
      } catch {
        /* listener errors are non-fatal */
      }
    }
  }

  /** Install the framed-stream reader; call once per session. */
  attach(ctx: AdapterContext): void {
    if (this.attached) return;
    this.attached = true;
    this.stream.reset();
    ctx.transport.setHandlers({
      onData: (b) => {
        for (const payload of this.stream.push(b)) {
          const resp = decodeStudioResponse(payload);
          if (!resp) continue;
          // Notification (lock_state_changed) — no request id
          if (resp.lockStateChanged) {
            ctx.onLog('info', `[zmk-studio] lock_state_changed -> ${resp.lockStateChanged}`);
            this.setLockState(resp.lockStateChanged);
            continue;
          }
          const w = resp.requestId !== undefined ? this.waiters.get(resp.requestId) : undefined;
          if (w && resp.requestId !== undefined) {
            this.waiters.delete(resp.requestId);
            clearTimeout(w.timer);
            w.resolve(resp);
          }
        }
      },
      onOpen: () => {},
      onClose: () => {
        for (const w of this.waiters.values()) {
          clearTimeout(w.timer);
          w.resolve(null);
        }
        this.waiters.clear();
        this.setLockState('unknown');
      },
      onError: (e) => ctx.onLog('error', `[zmk-studio] transport error: ${e.message}`),
    });
  }

  /** Send a Request and await the matching RequestResponse. */
  private async rpc(ctx: AdapterContext, core?: StudioRequest['core'], keymap?: StudioRequest['keymap']): Promise<StudioResponse | null> {
    this.attach(ctx);
    const requestId = this.nextRequestId++;
    const bytes = zmkFrameEncode(encodeStudioRequest({ requestId, core, keymap }));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve(null);
      }, this.timeoutMs);
      this.waiters.set(requestId, { resolve, timer });
      void ctx.transport.write(bytes).catch((err) => {
        this.waiters.delete(requestId);
        clearTimeout(timer);
        resolve(null);
        ctx.onLog('error', `[zmk-studio] write failed: ${(err as Error).message}`);
      });
    });
  }

  async identify(ctx: AdapterContext): Promise<IdentifyResult> {
    const caps = ctx.profile.capabilities;
    const resp = await this.rpc(ctx, { kind: 'get_device_info' });
    if (!resp) {
      ctx.onLog('warn', '[zmk-studio] no Studio response — endpoint unavailable (firmware may not enable ZMK Studio)');
      return {
        status: 'unknown',
        capabilities: { ...caps },
        error: 'Studio endpoint unavailable; feature not enabled in current keyboard firmware',
      };
    }
    if (resp.error) {
      ctx.onLog('warn', `[zmk-studio] Studio returned meta error code ${resp.core && 'code' in resp.core ? (resp.core as { code?: number }).code : '?'}`);
      return { status: 'unknown', capabilities: { ...caps }, error: 'Studio RPC error during identification' };
    }
    const info = resp.core;
    if (!info || info.kind !== 'get_device_info') {
      return { status: 'unknown', capabilities: { ...caps }, error: 'unexpected Studio response' };
    }
    ctx.onLog('info', `[zmk-studio] identified device "${info.name}" (serial ${Buffer.from(info.serialNumber).toString('hex')})`);
    // query lock state (best-effort, still identified without it)
    let observed = '';
    const lockResp = await this.rpc(ctx, { kind: 'get_lock_state' });
    if (lockResp?.core && lockResp.core.kind === 'get_lock_state') {
      this.setLockState(lockResp.core.lockState);
      observed = `lock=${lockResp.core.lockState}`;
      ctx.onLog('info', `[zmk-studio] lock state: ${lockResp.core.lockState}`);
    }
    return { status: 'identified', capabilities: { ...caps }, observedVersion: observed || undefined };
  }

  async apply(op: CapabilityOp, ctx: AdapterContext): Promise<OpResult> {
    switch (op.kind) {
      case 'runtime-keymap': {
        const p = op.payload as { action: string };
        if (p.action === 'get-lock-state') {
          const resp = await this.rpc(ctx, { kind: 'get_lock_state' });
          if (!resp?.core || resp.core.kind !== 'get_lock_state') {
            return { ok: false, error: 'no lock state response', wrote: true };
          }
          this.setLockState(resp.core.lockState);
          if (resp.core.lockState !== 'unlocked') {
            return { ok: false, error: 'studio is locked — unlock is a physical action on the keyboard', wrote: true, needsPhysicalUnlock: true };
          }
          return { ok: true, wrote: true };
        }
        if (p.action === 'unlock') {
          // ROUND-16 FIX: there is NO unlock RPC in zmk-studio-messages
          // core.proto — only lock (field 3). Unlock happens physically on
          // the keyboard; the host waits for lock_state_changed. ZERO writes.
          ctx.onLog(
            'info',
            '[zmk-studio] unlock requested — waiting for PHYSICAL unlock on the keyboard (core.proto defines no unlock RPC); zero writes',
          );
          return {
            ok: false,
            wrote: false,
            bytes: 0,
            needsPhysicalUnlock: true,
            error: 'ZMK Studio unlock must be performed physically on the keyboard; waiting for lock_state_changed…',
          };
        }
        if (p.action === 'lock') {
          // explicit lock: the official core.Request.lock RPC is allowed
          const resp = await this.rpc(ctx, { kind: 'lock' });
          if (!resp) return { ok: false, error: 'no response to lock request', wrote: true };
          this.setLockState('locked');
          return { ok: true, wrote: true, error: resp.error ? 'studio reported an error on lock' : undefined };
        }
        if (p.action === 'get-keymap') {
          if (this.lockState === 'locked') {
            // known-locked: do not even send the request — wait for physical unlock
            return {
              ok: false,
              wrote: false,
              bytes: 0,
              needsPhysicalUnlock: true,
              error: 'studio is locked — unlock is a physical action on the keyboard; zero writes while locked',
            };
          }
          const resp = await this.rpc(ctx, undefined, { kind: 'get_keymap' });
          if (!resp?.keymap) {
            if (resp?.error) {
              return { ok: false, error: 'studio is locked (UNLOCK_REQUIRED) — unlock physically on the keyboard', wrote: true, needsPhysicalUnlock: true };
            }
            return { ok: false, error: 'no keymap response (is Studio unlocked?)', wrote: true };
          }
          return { ok: true, wrote: true, bytes: resp.keymap.layerCount };
        }
        return { ok: false, error: `unsupported runtime-keymap action ${String(p.action)}`, wrote: false };
      }
      default:
        return { ok: false, error: `ZMK Studio adapter does not implement capability "${op.kind}" (not part of Studio RPC)`, wrote: false };
    }
  }

  async close(): Promise<void> {
    for (const w of this.waiters.values()) clearTimeout(w.timer);
    this.waiters.clear();
    this.attached = false;
    this.lockListeners.clear();
  }
}
