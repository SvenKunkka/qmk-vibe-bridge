/**
 * Vial adapter (round-15). Vial is a fork of VIA with its own wire framing:
 * all packets are fixed 32 bytes; msg[0] = 0xFE (Vial magic prefix) and
 * msg[1] = command (per vial-qmk quantum/vial.c). Identification uses the
 * protocol's own handshake: vial_get_keyboard_id (cmd 0x00) which returns
 * VIAL_PROTOCOL_VERSION (uint32 LE) + keyboard UID.
 *
 * Same interface caveat as VIA: usage 0xFF60/0x61 alone is NOT enough — the
 * profile must be matched (user-assigned or VID/PID registry) before probing.
 */

import type { CapabilityId, CapabilityOp } from '../capabilities/model';
import type { AdapterContext, IdentifyResult, OpResult, ProtocolAdapter } from './types';
import { QMK_RAW_HID_REPORT_SIZE } from '../profiles/builtin';

export const VIAL_ADAPTER_ID = 'vial';

export const VIAL_MAGIC = 0xfe;
export const VIAL_CMD_GET_KEYBOARD_ID = 0x00;
export const VIAL_CMD_GET_UNLOCK_STATUS = 0x05;
export const VIAL_CMD_LOCK = 0x08;

/** Build the 32-byte Vial report: [0xFE, cmd, data…] zero-padded. */
export function vialReport(cmd: number, data: number[] = []): Uint8Array {
  const report = new Uint8Array(QMK_RAW_HID_REPORT_SIZE);
  report[0] = VIAL_MAGIC;
  report[1] = cmd;
  for (let i = 0; i < Math.min(data.length, QMK_RAW_HID_REPORT_SIZE - 2); i++) {
    report[i + 2] = data[i];
  }
  return report;
}

export class VialAdapter implements ProtocolAdapter {
  readonly id = VIAL_ADAPTER_ID;
  readonly profileId = 'vial';
  /** identification only — no control capability implemented (round-16 P1-3) */
  static readonly implementedCapabilities: CapabilityId[] = [];

  private inbox: Uint8Array[] = [];
  private waiters: Array<{ cmd: number; resolve: (r: Uint8Array | null) => void; timer: NodeJS.Timeout }> = [];

  attach(ctx: AdapterContext): void {
    this.inbox = [];
    this.waiters = [];
    ctx.transport.setHandlers({
      onData: (b) => this.onInbound(b),
      onOpen: () => {},
      onClose: () => {},
      onError: (e) => ctx.onLog('error', `[vial] transport error: ${e.message}`),
    });
  }

  private onInbound(bytes: Uint8Array): void {
    const cmd = bytes[1];
    const idx = this.waiters.findIndex((w) => w.cmd === cmd);
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(Uint8Array.from(bytes));
    } else {
      this.inbox.push(Uint8Array.from(bytes));
    }
  }

  private drain(cmd: number): Uint8Array | null {
    const idx = this.inbox.findIndex((r) => r[1] === cmd);
    if (idx < 0) return null;
    const [hit] = this.inbox.splice(idx, 1);
    return hit;
  }

  async identify(ctx: AdapterContext): Promise<IdentifyResult> {
    const caps = ctx.profile.capabilities;
    this.attach(ctx);
    const resp = await this.roundTrip(ctx, vialReport(VIAL_CMD_GET_KEYBOARD_ID), 1500);
    if (resp === null || resp[0] !== VIAL_MAGIC) {
      ctx.onLog('warn', '[vial] no Vial response to get_keyboard_id — Vial not confirmed, zero writes');
      return { status: 'unknown', capabilities: { ...caps }, error: 'no Vial response (device may not run Vial firmware)' };
    }
    const version = (resp[2] | (resp[3] << 8) | (resp[4] << 16) | (resp[5] << 24)) >>> 0;
    ctx.onLog('info', `[vial] Vial confirmed, protocol version 0x${version.toString(16).padStart(8, '0')}`);
    return {
      status: 'identified',
      capabilities: { ...caps },
      observedVersion: `0x${version.toString(16).padStart(8, '0')}`,
    };
  }

  roundTrip(ctx: AdapterContext, report: Uint8Array, timeoutMs: number): Promise<Uint8Array | null> {
    const buffered = this.drain(report[1]);
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.cmd === report[1]);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push({ cmd: report[1], resolve, timer });
      void ctx.transport.write(report).catch((err) => {
        const idx = this.waiters.findIndex((w) => w.cmd === report[1]);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          clearTimeout(timer);
        }
        resolve(null);
        ctx.onLog('error', `[vial] write failed during handshake: ${(err as Error).message}`);
      });
    });
  }

  async apply(op: CapabilityOp, ctx: AdapterContext): Promise<OpResult> {
    switch (op.kind) {
      case 'runtime-keymap': {
        const p = op.payload as { action: string };
        if (p.action === 'get-unlock-status') {
          const resp = await this.roundTrip(ctx, vialReport(VIAL_CMD_GET_UNLOCK_STATUS), 1500);
          if (!resp) return { ok: false, error: 'no Vial response', wrote: true };
          return { ok: true, wrote: true, bytes: resp.length };
        }
        return { ok: false, error: `unsupported runtime-keymap action ${String(p.action)} (needs keyboard definition JSON)`, wrote: false };
      }
      default:
        return { ok: false, error: `Vial adapter does not implement capability "${op.kind}"`, wrote: false };
    }
  }

  async close(): Promise<void> {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    this.inbox = [];
  }
}
