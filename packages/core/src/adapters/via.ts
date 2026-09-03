/**
 * VIA adapter (round-15). VIA speaks over the same 0xFF60/0x61 Raw HID
 * interface as bare QMK Raw HID — the profile must therefore be matched
 * (user-assigned or VID/PID registry) BEFORE any probe. Identification uses
 * the protocol's own handshake: GET_PROTOCOL_VERSION (cmd 0x01).
 *
 * Wire format (per the-via/app keyboard-api + QMK quantum/via.c):
 *   send:   33-byte HID write [reportId 0x00, cmd, data…]  (32-byte report)
 *   reply:  echoes cmd at byte 0; GET_PROTOCOL_VERSION -> hi,lo at bytes 1,2
 */

import type { CapabilityId, CapabilityMap, CapabilityOp } from '../capabilities/model';
import type { AdapterContext, IdentifyResult, OpResult, ProtocolAdapter } from './types';
import { QMK_RAW_HID_REPORT_SIZE } from '../profiles/builtin';

export const VIA_ADAPTER_ID = 'via';

export const VIA_CMD_GET_PROTOCOL_VERSION = 0x01;
export const VIA_CMD_DYNAMIC_KEYMAP_SET_KEYCODE = 0x05;
export const VIA_CMD_DYNAMIC_KEYMAP_GET_LAYER_COUNT = 0x11;
// official lighting channels (via.h via_channel_id) + value ids
export const VIA_CHANNEL_BACKLIGHT = 1;
export const VIA_CHANNEL_RGBLIGHT = 2;
export const VIA_CHANNEL_RGB_MATRIX = 3;
export const VIA_VALUE_BRIGHTNESS = 1;
export const VIA_VALUE_COLOR = 4;
export const VIA_CMD_CUSTOM_SET_VALUE = 0x07;
export const VIA_CMD_CUSTOM_GET_VALUE = 0x08;
export const VIA_CMD_CUSTOM_SAVE = 0x09;
export const VIA_CMD_UNHANDLED = 0xff;

/** RGB (0..255) -> HSV hue(0..255)/sat(0..255) for rgblight/rgb_matrix. */
export function rgbToHsv(r: number, g: number, b: number): { hue: number; sat: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  const sat = max === 0 ? 0 : (d / max);
  return { hue: Math.round((h / 360) * 255), sat: Math.round(sat * 255) };
}

/** Build the 32-byte VIA report: [cmd, data…] zero-padded. */
export function viaReport(cmd: number, data: number[] = []): Uint8Array {
  const report = new Uint8Array(QMK_RAW_HID_REPORT_SIZE);
  report[0] = cmd;
  for (let i = 0; i < Math.min(data.length, QMK_RAW_HID_REPORT_SIZE - 1); i++) {
    report[i + 1] = data[i];
  }
  return report;
}

export class ViaAdapter implements ProtocolAdapter {
  readonly id = VIA_ADAPTER_ID;
  readonly profileId = 'via';
  /** capabilities with a real handler in apply() (round-17: + lighting) */
  static readonly implementedCapabilities: CapabilityId[] = [
    'runtime-keymap', 'set-rgb', 'set-rgb-matrix', 'set-backlight',
  ];

  /** inbound reports queued since identify()/attach() */
  private inbox: Uint8Array[] = [];
  private waiters: Array<{ cmd: number; resolve: (r: Uint8Array | null) => void; timer: NodeJS.Timeout }> = [];

  /** Install inbound-data capture; must be called once per session start. */
  attach(ctx: AdapterContext): void {
    this.inbox = [];
    this.waiters = [];
    ctx.transport.setHandlers({
      onData: (b) => this.onInbound(b),
      onOpen: () => {},
      onClose: () => {},
      onError: (e) => ctx.onLog('error', `[via] transport error: ${e.message}`),
    });
  }

  private onInbound(bytes: Uint8Array): void {
    // route to the first waiter expecting this command echo
    const idx = this.waiters.findIndex((w) => w.cmd === bytes[0]);
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(Uint8Array.from(bytes));
    } else {
      this.inbox.push(Uint8Array.from(bytes));
    }
  }

  /** Check buffered reports for an echo of `cmd`. */
  private drain(cmd: number): Uint8Array | null {
    const idx = this.inbox.findIndex((r) => r[0] === cmd);
    if (idx < 0) return null;
    const [hit] = this.inbox.splice(idx, 1);
    return hit;
  }

  async identify(ctx: AdapterContext): Promise<IdentifyResult> {
    const caps = { ...ctx.profile.capabilities } as CapabilityMap;
    this.attach(ctx);
    // protocol's own handshake: GET_PROTOCOL_VERSION
    const report = viaReport(VIA_CMD_GET_PROTOCOL_VERSION);
    const resp = await this.roundTrip(ctx, report, 1500);
    if (resp === null) {
      ctx.onLog('warn', '[via] no VIA response to GET_PROTOCOL_VERSION — VIA not confirmed, zero writes');
      return { status: 'unknown', capabilities: caps, error: 'no VIA response (device may not run VIA firmware)' };
    }
    const hi = resp[1] ?? 0;
    const lo = resp[2] ?? 0;
    const protocolVersion = (hi << 8) | lo;
    ctx.onLog('info', `[via] VIA confirmed, protocol version 0x${protocolVersion.toString(16).padStart(4, '0')}`);
    // round-17 (P4): if a definition is bound, probe official lighting
    // channels (id_custom_get_value) — the probe is a READ; unhandled (0xFF)
    // or timeout means the firmware does not compile that channel.
    const bound = ctx.profile.definition?.kind === 'imported';
    if (bound) {
      ctx.onLog('info', '[via] definition bound — probing lighting channels (official get_value)');
      const probe = await this.probeLightingChannels(ctx, 400);
      caps['set-backlight'] = probe.backlight ? 'supported' : 'unsupported';
      caps['set-rgb'] = probe.rgblight ? 'supported' : 'unsupported';
      caps['set-rgb-matrix'] = probe.rgbMatrix ? 'supported' : 'unsupported';
      ctx.onLog('info', `[via] lighting probe: backlight=${probe.backlight} rgblight=${probe.rgblight} rgb_matrix=${probe.rgbMatrix}`);
    } else {
      ctx.onLog('info', '[via] no definition bound — lighting stays requires-user-profile (needs bind + probe)');
    }
    return {
      status: 'identified',
      capabilities: caps,
      observedVersion: `0x${protocolVersion.toString(16).padStart(4, '0')}`,
    };
  }

  /**
   * Official channel probe: id_custom_get_value `[0x08, channel, value_id]`.
   * A channel the firmware does not compile responds with command 0xFF
   * (id_unhandled) or not at all — either way it is unsupported.
   */
  async probeLightingChannels(
    ctx: AdapterContext,
    timeoutMs = 400,
  ): Promise<{ backlight: boolean; rgblight: boolean; rgbMatrix: boolean }> {
    const probeChannel = async (channel: number, valueId: number): Promise<boolean> => {
      // unhandled is signaled at BYTE 0 (command id = 0xFF), never at value
      // bytes — a legal brightness of 255 (0xFF) must not be misread.
      const resp = await this.roundTrip(
        ctx,
        viaReport(VIA_CMD_CUSTOM_GET_VALUE, [channel, valueId]),
        timeoutMs,
        (e) => e[0] === VIA_CMD_CUSTOM_GET_VALUE && e[1] === channel,
      );
      return resp !== null;
    };
    return {
      backlight: await probeChannel(VIA_CHANNEL_BACKLIGHT, VIA_VALUE_BRIGHTNESS),
      rgblight: await probeChannel(VIA_CHANNEL_RGBLIGHT, VIA_VALUE_COLOR),
      rgbMatrix: await probeChannel(VIA_CHANNEL_RGB_MATRIX, VIA_VALUE_COLOR),
    };
  }

  /**
   * Send a report and wait for the echoing response. `validate` (optional)
   * checks the echoed payload (e.g. layer/row/col/keycode for set-keycode).
   * Returns the validated echo or null on timeout/wrong echo.
   */
  roundTrip(ctx: AdapterContext, report: Uint8Array, timeoutMs: number, validate?: (echo: Uint8Array) => boolean): Promise<Uint8Array | null> {
    const buffered = this.drain(report[0]);
    if (buffered) return Promise.resolve(validate ? (validate(buffered) ? buffered : null) : buffered);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.cmd === report[0]);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = {
        cmd: report[0],
        resolve: (echo: Uint8Array | null) => {
          if (echo && validate && !validate(echo)) {
            ctx.onLog('warn', '[via] echo validation failed (payload mismatch)');
            resolve(null);
          } else {
            resolve(echo);
          }
        },
        timer,
      };
      this.waiters.push(waiter);
      void ctx.transport.write(report).catch((err) => {
        const idx = this.waiters.findIndex((w) => w.cmd === report[0]);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          clearTimeout(timer);
        }
        resolve(null);
        ctx.onLog('error', `[via] write failed during handshake: ${(err as Error).message}`);
      });
    });
  }

  async apply(op: CapabilityOp, ctx: AdapterContext): Promise<OpResult> {
    switch (op.kind) {
      case 'runtime-keymap': {
        const p = op.payload as { action: string; layer?: number; row?: number; col?: number; keycode?: number };
        if (p.action === 'set-keycode' && p.layer !== undefined && p.row !== undefined && p.col !== undefined && p.keycode !== undefined) {
          const hi = (p.keycode >> 8) & 0xff;
          const lo = p.keycode & 0xff;
          const report = viaReport(VIA_CMD_DYNAMIC_KEYMAP_SET_KEYCODE, [p.layer, p.row, p.col, hi, lo]);
          // round-16 (P2-5): wait for the protocol echo and validate it —
          // a write is only "successful" when the device echoes the exact
          // command + layer/row/col/keycode bytes
          const echo = await this.roundTrip(
            ctx, report, 1500,
            (e) =>
              e[0] === VIA_CMD_DYNAMIC_KEYMAP_SET_KEYCODE &&
              e[1] === p.layer && e[2] === p.row && e[3] === p.col &&
              e[4] === hi && e[5] === lo,
          );
          if (echo === null) {
            ctx.onLog('warn', `[via] set-keycode: no valid echo (layer ${p.layer}, ${p.row},${p.col})`);
            return { ok: false, error: 'VIA set-keycode failed: no matching echo (timeout or payload mismatch)', wrote: true };
          }
          ctx.onLog('info', `[via] dynamic keymap set (layer ${p.layer}, ${p.row},${p.col}) — echo verified`);
          return { ok: true, wrote: true, bytes: report.length };
        }
        if (p.action === 'get-layer-count') {
          const resp = await this.roundTrip(ctx, viaReport(VIA_CMD_DYNAMIC_KEYMAP_GET_LAYER_COUNT), 1500);
          if (!resp) return { ok: false, error: 'no VIA response', wrote: true };
          return { ok: true, wrote: true, bytes: resp.length };
        }
        return { ok: false, error: `unsupported runtime-keymap action ${String(p.action)}`, wrote: false };
      }
      case 'set-rgb':
      case 'set-rgb-matrix':
      case 'set-backlight': {
        return this.lightingOp(op, ctx);
      }
      default:
        return { ok: false, error: `VIA adapter does not implement capability "${op.kind}"`, wrote: false };
    }
  }

  /**
   * VIA lighting (round-17 P4). Official wire (via.c):
   *   set   `[0x07, channel, value_id, value_data…]`
   *   read  `[0x08, channel, value_id]` → current value
   * A write is 'applied' only when the official readback confirms the value;
   * a write with a valid echo but no readback is 'sent-unverified'.
   */
  private async lightingOp(op: CapabilityOp, ctx: AdapterContext): Promise<OpResult> {
    const p = op.payload as { mode?: string; color?: { r: number; g: number; b: number }; brightness?: number };
    let channel: number;
    let valueId: number;
    let data: number[];
    let verify: (echo: Uint8Array) => boolean;

    if (op.kind === 'set-backlight') {
      channel = VIA_CHANNEL_BACKLIGHT;
      valueId = VIA_VALUE_BRIGHTNESS;
      const brightness = Math.max(0, Math.min(255, Math.round((p.brightness ?? 100) * 2.55)));
      data = [brightness];
      verify = (e) => e[3] === brightness;
    } else {
      channel = op.kind === 'set-rgb' ? VIA_CHANNEL_RGBLIGHT : VIA_CHANNEL_RGB_MATRIX;
      valueId = VIA_VALUE_COLOR;
      const color = p.color ?? { r: 255, g: 255, b: 255 };
      const { hue, sat } = rgbToHsv(color.r, color.g, color.b);
      data = [hue, sat];
      verify = (e) => e[3] === hue && e[4] === sat;
    }

    const setReport = viaReport(VIA_CMD_CUSTOM_SET_VALUE, [channel, valueId, ...data]);
    const echo = await this.roundTrip(
      ctx, setReport, 1500,
      (e) => e[0] === VIA_CMD_CUSTOM_SET_VALUE && e[1] === channel && e[2] === valueId,
    );
    if (echo === null) {
      ctx.onLog('warn', `[via] ${op.kind}: no valid echo for channel ${channel} — write not confirmed`);
      return { ok: false, error: `VIA ${op.kind}: no valid echo (channel unsupported or timeout)`, wrote: true, result: 'failed' };
    }
    // official readback verification
    const readback = await this.roundTrip(
      ctx, viaReport(VIA_CMD_CUSTOM_GET_VALUE, [channel, valueId]), 1500,
      (e) => e[0] === VIA_CMD_CUSTOM_GET_VALUE && e[1] === channel,
    );
    if (readback === null) {
      ctx.onLog('warn', `[via] ${op.kind}: write echoed but no readback — sent-unverified`);
      return { ok: false, error: `VIA ${op.kind}: sent but not verified (no readback)`, wrote: true, result: 'sent-unverified' };
    }
    if (!verify(readback)) {
      ctx.onLog('warn', `[via] ${op.kind}: readback mismatch (got ${readback[3]},${readback[4] ?? ''})`);
      return { ok: false, error: `VIA ${op.kind}: readback mismatch — not applied`, wrote: true, result: 'failed' };
    }
    ctx.onLog('info', `[via] ${op.kind} applied (channel ${channel}, readback verified)`);
    return { ok: true, wrote: true, result: 'applied' };
  }

  async close(): Promise<void> {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    this.inbox = [];
  }
}
