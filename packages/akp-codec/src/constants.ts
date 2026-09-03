/**
 * AKP (Agent Keyboard Protocol) v1 — shared constants.
 *
 * The protocol is fully documented in docs/PROTOCOL.md. This file is the
 * single source of truth for wire constants used by host app, firmware
 * modules (C mirrors live under firmware/) and simulators.
 */

export const PROTO_NAME = 'AKP';
export const PROTO_VERSION = 1;

/** HID report magic byte — first byte of every HID frame. */
export const FRAME_MAGIC = 0xa5;
/** Message-level magic byte — first byte of every logical message. */
export const MSG_MAGIC = 0x4b; // 'K'

/** Default HID report sizes per transport family. */
export const MTU_QMK = 32; // QMK RAW_EPSIZE default
export const MTU_ZMK = 64; // ZMK raw HID / BLE reports
export const MTU_DEFAULT = MTU_QMK;

/** Frame header size: magic(1) + flags(1) + length(1) + crc(1) */
export const FRAME_HEADER = 4;
export const FRAME_FLAG_MORE = 0x80;
export const FRAME_INDEX_MASK = 0x0f;

/** Message header size: magic(1)+version(1)+type(1)+flags(1)+seq(2)+len(2).
 * A trailing 2-byte CRC-16 completes every message. */
export const MSG_HEADER = 8;
export const MSG_FLAG_ACK_REQ = 0x01;

export const CRC8_INIT = 0x00;
export const CRC16_INIT = 0xffff;

export enum MsgType {
  HELLO = 0x01, // keyboard -> host : identity + capability list
  CAPS = 0x02, // host -> keyboard : negotiated capabilities (feature on/off)
  HEARTBEAT = 0x03, // both directions : liveness + state piggyback
  CMD = 0x04, // keyboard -> host : action request (approve, reject, ...)
  STATE = 0x05, // host -> keyboard : agent state + color
  RGB = 0x06, // host -> keyboard : lighting (solid / effect / per-key)
  SCREEN = 0x07, // host -> keyboard : OLED screen content
  ACK = 0x08, // both directions : acknowledgement
  ERR = 0x09, // both directions : error report
  DICTATE = 0x0a, // both directions : dictation status
  ENCODER = 0x0b, // keyboard -> host : encoder rotation
  KEYEVENT = 0x0c, // keyboard -> host : raw custom key event
  LOG = 0x0d, // host -> keyboard : debug line for OLED
}

/** Agent runtime states (UI, protocol, firmware colors). */
export enum AgentState {
  IDLE = 'idle',
  THINKING = 'thinking',
  TOOL = 'tool',
  WAITING = 'waiting', // awaiting user approval
  DONE = 'done',
  ERROR = 'error',
  DISCONNECTED = 'disconnected',
  DICTATING = 'dictating',
}

/** Keyboard actions (keyboard -> host CMD payload.action). */
export const Actions = [
  'select_agent',
  'approve',
  'reject',
  'new_task',
  'send',
  'dictate',
  'fast_mode',
  'reasoning_up',
  'reasoning_down',
  'cancel',
  'interrupt',
  'pause',
  'resume',
  'custom',
] as const;
export type ActionName = (typeof Actions)[number];

/** Device features advertised by firmware and negotiated via CAPS. */
export const Features = [
  'raw_hid',
  'f13_f24',
  'encoder',
  'rgb_matrix',
  'rgb_light',
  'oled',
  'status_led',
  'audio',
] as const;
export type FeatureName = (typeof Features)[number];

export interface RGB { r: number; g: number; b: number; }

/** Default status colors — spec: idle white / thinking blue / tool purple /
 * waiting orange / done green / error red / disconnected off. */
export const DEFAULT_STATE_COLORS: Record<AgentState, RGB> = {
  [AgentState.IDLE]: { r: 255, g: 255, b: 255 },
  [AgentState.THINKING]: { r: 0, g: 120, b: 255 },
  [AgentState.TOOL]: { r: 150, g: 60, b: 220 },
  [AgentState.WAITING]: { r: 255, g: 140, b: 0 },
  [AgentState.DONE]: { r: 0, g: 220, b: 80 },
  [AgentState.ERROR]: { r: 255, g: 40, b: 40 },
  [AgentState.DISCONNECTED]: { r: 0, g: 0, b: 0 },
  [AgentState.DICTATING]: { r: 0, g: 255, b: 255 },
};

export function colorForState(state: AgentState | string, overrides?: Partial<Record<string, RGB>>): RGB {
  const s = state as AgentState;
  const o = overrides ? overrides[state] : undefined;
  return o ?? DEFAULT_STATE_COLORS[s] ?? DEFAULT_STATE_COLORS[AgentState.IDLE];
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

export function rgbToHex(rgb: RGB): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}
