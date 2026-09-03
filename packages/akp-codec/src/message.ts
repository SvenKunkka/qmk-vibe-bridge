/**
 * AKP logical message codec.
 *
 * Message layout (little-endian):
 *   [0]  u8  magic    = MSG_MAGIC (0x4B)
 *   [1]  u8  version  = PROTO_VERSION (1)
 *   [2]  u8  type     = MsgType
 *   [3]  u8  flags    = MSG_FLAG_*
 *   [4..5]  u16 seq
 *   [6..7]  u16 payload_len
 *   [8 .. 8+payload_len)  payload
 *   [..+2]  u16 crc16 (over bytes 0 .. 8+payload_len-1)
 *
 * Payloads are JSON (UTF-8) for most types; RGB may be binary per-key.
 */

import { CRC16_INIT, MSG_FLAG_ACK_REQ, MSG_HEADER, MSG_MAGIC, PROTO_VERSION } from './constants';
import { crc16 } from './crc';
import type { MsgType } from './constants';

export interface AkpMessage {
  type: MsgType;
  seq: number;
  flags: number;
  payload: Uint8Array;
  /** JSON payload cached after parse (set by decodeMessage). */
  json?: unknown;
}

const enum Size {
  PayloadLen = 2,
  Seq = 2,
}

export function encodeMessage(type: MsgType, payload: Uint8Array | string | object | null, seq: number, opts?: { ackRequested?: boolean }): Uint8Array {
  let payloadBytes: Uint8Array;
  if (payload == null) {
    payloadBytes = new Uint8Array(0);
  } else if (typeof payload === 'string') {
    payloadBytes = new TextEncoder().encode(payload);
  } else if (payload instanceof Uint8Array) {
    payloadBytes = payload;
  } else {
    payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  }
  if (payloadBytes.length > 0xffff) {
    throw new Error(`AKP message payload too large: ${payloadBytes.length}`);
  }
  const total = MSG_HEADER + payloadBytes.length + 2;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  buf[0] = MSG_MAGIC;
  buf[1] = PROTO_VERSION;
  buf[2] = type;
  buf[3] = opts?.ackRequested ? MSG_FLAG_ACK_REQ : 0;
  dv.setUint16(4, seq & 0xffff, true);
  dv.setUint16(6, payloadBytes.length, true);
  buf.set(payloadBytes, 8);
  dv.setUint16(total - 2, crc16(buf.subarray(0, total - 2), CRC16_INIT), true);
  return buf;
}

export function encodeJsonMessage(type: MsgType, obj: object, seq: number, opts?: { ackRequested?: boolean }): Uint8Array {
  return encodeMessage(type, JSON.stringify(obj), seq, opts);
}

export interface DecodeResult {
  message: AkpMessage;
  /** Number of bytes consumed (normally buffer.length). */
  consumed: number;
}

export class ProtocolError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Decode a single complete message from a byte buffer. Throws ProtocolError on
 * structural failure; returns { consumed: 0 } when the buffer holds an
 * incomplete message. */
export function decodeMessage(buf: Uint8Array): DecodeResult {
  if (buf.length < MSG_HEADER) {
    return { consumed: 0, message: null as unknown as AkpMessage };
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf[0] !== MSG_MAGIC) {
    throw new ProtocolError(`bad message magic 0x${buf[0].toString(16)}`, 'bad_magic');
  }
  const version = buf[1];
  if (version !== PROTO_VERSION) {
    throw new ProtocolError(`unsupported protocol version ${version}`, 'bad_version');
  }
  const payloadLen = dv.getUint16(6, true);
  const total = MSG_HEADER + payloadLen + 2;
  if (buf.length < total) {
    return { consumed: 0, message: null as unknown as AkpMessage };
  }
  const expected = dv.getUint16(total - 2, true);
  const actual = crc16(buf.subarray(0, total - 2), CRC16_INIT);
  if (actual !== expected) {
    throw new ProtocolError(`crc16 mismatch (expected ${expected}, got ${actual})`, 'bad_crc');
  }
  const payload = buf.slice(MSG_HEADER, MSG_HEADER + payloadLen);
  const message: AkpMessage = {
    type: buf[2],
    seq: dv.getUint16(4, true),
    flags: buf[3],
    payload,
  };
  if (payload.length > 0) {
    try {
      message.json = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      message.json = undefined; // binary payloads (e.g. per-key RGB)
    }
  }
  return { consumed: total, message };
}

/** Decode JSON payload into a typed object. */
export function jsonOf<T = Record<string, unknown>>(msg: AkpMessage): T | undefined {
  return msg.json as T | undefined;
}

export function ackRequested(msg: AkpMessage): boolean {
  return (msg.flags & MSG_FLAG_ACK_REQ) !== 0;
}
