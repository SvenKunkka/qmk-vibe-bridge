/**
 * Typed AKP payload builders/parsers — the ergonomic surface used by the host
 * app, simulators and tests. Wire format is documented in docs/PROTOCOL.md.
 */

import {
  Actions,
  AgentState,
  type ActionName,
  type FeatureName,
  type RGB,
} from './constants';
import { encodeJsonMessage, encodeMessage, jsonOf, type AkpMessage, type DecodeResult, decodeMessage } from './message';
import { MsgType } from './constants';

export interface HelloPayload {
  proto: number;
  fw: 'qmk' | 'zmk' | 'virtual';
  fw_version: string;
  vendor?: string;
  product?: string;
  layout?: string;
  features: FeatureName[];
  /** per-key RGB LED count (0 = none) */
  led_count?: number;
  rgbw?: boolean;
  oled_lines?: number;
  encoder_count?: number;
  mtu?: number;
}

export interface CapsPayload {
  proto: number;
  features: FeatureName[];
  rgb?: { per_key: boolean; led_count: number; rgbw: boolean; brightness: number };
  oled?: { lines: number; enabled: boolean };
  status_led?: { enabled: boolean };
  encoder?: { enabled: boolean };
  mtu?: number;
}

export interface HeartbeatPayload {
  t: number; // epoch seconds
  state?: AgentState;
  seq?: number;
  battery?: number; // 0-100, optional (BLE)
}

export interface CmdPayload {
  action: ActionName;
  /** key that triggered (F13..F24, knob, ...) */
  source: string;
  ts: number;
  /** for action === 'custom' */
  name?: string;
  /** key press count for double/triple tap disambiguation */
  press_count?: number;
  mods?: string[];
}

export interface StatePayload {
  state: AgentState;
  agent?: string;
  agent_id?: string;
  session?: string;
  text?: string;
  color?: RGB;
  since?: number;
  progress?: number; // 0-1
  step?: string;
}

export interface RgbJsonPayload {
  mode: 'solid' | 'effect' | 'matrix' | 'off';
  color?: RGB;
  effect?: string; // e.g. 'breathing','cycle','wave','rainbow'
  brightness?: number; // 0-100
  per_key?: boolean;
  speed?: number; // 0-255
}

export interface ScreenPayload {
  lines: string[];
  title?: string;
  bar?: { value: number; max: number };
  clear?: boolean;
}

export interface AckPayload {
  ok: boolean;
  ack_seq: number;
  error?: string;
}

export interface ErrPayload {
  code: string;
  msg?: string;
}

export interface EncoderPayload {
  dir: -1 | 1;
  delta?: number;
  ts: number;
}

export interface KeyEventPayload {
  key: string;
  state: 'down' | 'up' | 'tap';
  ts: number;
}

export interface DictatePayload {
  status: 'started' | 'finished' | 'error';
  text?: string;
  ts: number;
}

export interface LogPayload {
  line: string;
  level?: 'info' | 'warn' | 'error';
}

const ok = <T>(r: DecodeResult): AkpMessage => {
  if (r.consumed === 0) throw new Error('incomplete message');
  return r.message;
};

export function buildHello(hello: HelloPayload, seq: number): Uint8Array {
  return encodeJsonMessage(MsgType.HELLO, hello, seq);
}
export function parseHello(msg: AkpMessage): HelloPayload {
  return jsonOf<HelloPayload>(msg)!;
}

export function buildCaps(caps: CapsPayload, seq: number): Uint8Array {
  return encodeJsonMessage(MsgType.CAPS, caps, seq);
}
export function parseCaps(msg: AkpMessage): CapsPayload {
  return jsonOf<CapsPayload>(msg)!;
}

export function buildHeartbeat(hb: HeartbeatPayload, seq: number): Uint8Array {
  return encodeJsonMessage(MsgType.HEARTBEAT, hb, seq);
}
export function parseHeartbeat(msg: AkpMessage): HeartbeatPayload {
  return jsonOf<HeartbeatPayload>(msg)!;
}

export function buildCmd(cmd: CmdPayload, seq: number): Uint8Array {
  return encodeJsonMessage(MsgType.CMD, cmd, seq);
}
export function parseCmd(msg: AkpMessage): CmdPayload {
  return jsonOf<CmdPayload>(msg)!;
}

export function buildState(state: StatePayload, seq: number): Uint8Array {
  return encodeJsonMessage(MsgType.STATE, state, seq);
}
export function parseState(msg: AkpMessage): StatePayload {
  return jsonOf<StatePayload>(msg)!;
}

export function buildRgb(rgb: RgbJsonPayload, seq: number): Uint8Array {
  return encodeJsonMessage(MsgType.RGB, rgb, seq);
}
export function parseRgb(msg: AkpMessage): RgbJsonPayload {
  return jsonOf<RgbJsonPayload>(msg)!;
}

/** Binary per-key RGB payload: [flags u8, led_count u16 LE, rgb*count (or rgba)]. */
export function buildRgbPerKey(leds: Array<RGB | [number, number, number, number]>, seq: number): Uint8Array {
  const rgbw = leds.length > 0 && Array.isArray(leds[0]) && (leds[0] as number[]).length === 4;
  const buf = new Uint8Array(3 + leds.length * (rgbw ? 4 : 3));
  const dv = new DataView(buf.buffer);
  buf[0] = 0x01 | (rgbw ? 0x02 : 0);
  dv.setUint16(1, leds.length, true);
  let off = 3;
  for (const led of leds) {
    const arr = Array.isArray(led) ? led : [led.r, led.g, led.b, 255];
    buf[off++] = arr[0];
    buf[off++] = arr[1];
    buf[off++] = arr[2];
    if (rgbw) buf[off++] = arr[3];
  }
  return encodeMessage(MsgType.RGB, buf, seq);
}

export function buildScreen(screen: ScreenPayload, seq: number): Uint8Array {
  return encodeJsonMessage(MsgType.SCREEN, screen, seq);
}
export function parseScreen(msg: AkpMessage): ScreenPayload {
  return jsonOf<ScreenPayload>(msg)!;
}

export function buildAck(ackSeq: number, okFlag: boolean, error?: string, seq = 0): Uint8Array {
  return encodeJsonMessage(MsgType.ACK, { ok: okFlag, ack_seq: ackSeq, error } satisfies AckPayload, seq);
}
export function parseAck(msg: AkpMessage): AckPayload {
  return jsonOf<AckPayload>(msg)!;
}

export function buildErr(code: string, msg?: string, seq = 0): Uint8Array {
  return encodeJsonMessage(MsgType.ERR, { code, msg } satisfies ErrPayload, seq);
}
export function parseErr(msg: AkpMessage): ErrPayload {
  return jsonOf<ErrPayload>(msg)!;
}

export function buildEncoder(dir: -1 | 1, ts: number, delta?: number, seq = 0): Uint8Array {
  return encodeJsonMessage(MsgType.ENCODER, { dir, delta, ts } satisfies EncoderPayload, seq);
}
export function parseEncoder(msg: AkpMessage): EncoderPayload {
  return jsonOf<EncoderPayload>(msg)!;
}

export function buildKeyEvent(key: string, state: 'down' | 'up' | 'tap', ts: number, seq = 0): Uint8Array {
  return encodeJsonMessage(MsgType.KEYEVENT, { key, state, ts } satisfies KeyEventPayload, seq);
}
export function parseKeyEvent(msg: AkpMessage): KeyEventPayload {
  return jsonOf<KeyEventPayload>(msg)!;
}

export function buildDictate(status: 'started' | 'finished' | 'error', ts: number, text?: string, seq = 0): Uint8Array {
  return encodeJsonMessage(MsgType.DICTATE, { status, ts, text } satisfies DictatePayload, seq);
}
export function parseDictate(msg: AkpMessage): DictatePayload {
  return jsonOf<DictatePayload>(msg)!;
}

export function buildLog(line: string, level: 'info' | 'warn' | 'error' = 'info', seq = 0): Uint8Array {
  return encodeJsonMessage(MsgType.LOG, { line, level } satisfies LogPayload, seq);
}

export function decodeAny(buf: Uint8Array): DecodeResult {
  return decodeMessage(buf);
}

export { Actions, AgentState, MsgType };
export type { ActionName, FeatureName, RGB };
