/**
 * AKP HID frame codec + fragmentation / reassembly.
 *
 * One logical message may exceed the HID report size, so messages are split
 * into frames. Frame layout (per HID report, report-id tolerant):
 *
 *   [0] u8 magic = FRAME_MAGIC (0xA5)
 *   [1] u8 flags: bit7 MORE (more frames follow); bits3..0 frame index (0-15)
 *   [2] u8 length (bytes of message data in this frame)
 *   [3 .. 3+length) message data
 *   [3+length] u8 crc8 over bytes [0 .. 3+length-1]
 *
 * Total frame size <= mtu (32 default for QMK, 64 for ZMK/BLE). A leading
 * HID report-id byte (0x00/0x01) on some platforms is tolerated by
 * re-scanning the buffer one byte in when the magic does not match.
 */

import { CRC8_INIT, FRAME_FLAG_MORE, FRAME_HEADER, FRAME_INDEX_MASK, FRAME_MAGIC, MTU_DEFAULT } from './constants';
import { crc8 } from './crc';
import { ProtocolError } from './message';

export const MAX_FRAME_DATA = (mtu: number) => Math.max(8, mtu - FRAME_HEADER);

export interface Frame {
  more: boolean;
  index: number;
  data: Uint8Array;
  /** raw frame bytes (already includes magic/flags/length/crc) */
  bytes: Uint8Array;
}

/** Split a message byte array into HID frames of the given MTU. */
export function frameMessage(message: Uint8Array, mtu: number = MTU_DEFAULT): Frame[] {
  if (mtu < 8) throw new Error(`MTU too small: ${mtu}`);
  const maxData = MAX_FRAME_DATA(mtu);
  const frames: Frame[] = [];
  let offset = 0;
  let index = 0;
  while (offset < message.length || frames.length === 0) {
    const chunk = message.subarray(offset, offset + maxData);
    const more = offset + chunk.length < message.length;
    frames.push(encodeFrame(chunk, more, index, mtu));
    offset += chunk.length;
    index = (index + 1) & FRAME_INDEX_MASK;
    if (offset >= message.length) break;
  }
  return frames;
}

export function encodeFrame(data: Uint8Array, more: boolean, index: number, mtu: number = MTU_DEFAULT): Frame {
  if (index < 0 || index > FRAME_INDEX_MASK) throw new Error(`frame index out of range: ${index}`);
  if (data.length > MAX_FRAME_DATA(mtu)) {
    throw new Error(`frame data too large: ${data.length} > ${MAX_FRAME_DATA(mtu)}`);
  }
  const buf = new Uint8Array(data.length + FRAME_HEADER);
  buf[0] = FRAME_MAGIC;
  buf[1] = (more ? FRAME_FLAG_MORE : 0) | (index & FRAME_INDEX_MASK);
  buf[2] = data.length;
  buf.set(data, 3);
  buf[buf.length - 1] = crc8(buf.subarray(0, buf.length - 1), CRC8_INIT);
  return { more, index, data: buf.slice(3, 3 + data.length), bytes: buf };
}

export interface DecodedFrame {
  more: boolean;
  index: number;
  data: Uint8Array;
  /** bytes consumed from the report buffer (1 or 2 when a report-id byte was skipped). */
  consumed: number;
}

/**
 * Decode a single HID report (possibly with a leading report-id byte) into a
 * frame. Returns null when the report is not an AKP frame (magic mismatch).
 */
export function decodeFrame(report: Uint8Array): DecodedFrame | null {
  let offset = 0;
  if (report[0] !== FRAME_MAGIC) {
    if (report.length > 1 && report[1] === FRAME_MAGIC && (report[0] === 0x00 || report[0] === 0x01)) {
      offset = 1; // leading report id
    } else {
      return null;
    }
  }
  const flags = report[offset + 1];
  const len = report[offset + 2];
  if (offset + 3 + len > report.length) {
    throw new ProtocolError(`frame length ${len} exceeds report size ${report.length}`, 'frame_overflow');
  }
  const crcPos = offset + 3 + len;
  const crc = crc8(report.subarray(offset, crcPos), CRC8_INIT);
  if (report[crcPos] !== crc) {
    throw new ProtocolError(`frame crc mismatch`, 'frame_crc');
  }
  return {
    more: (flags & FRAME_FLAG_MORE) !== 0,
    index: flags & FRAME_INDEX_MASK,
    data: report.slice(offset + 3, crcPos),
    consumed: offset + 4 + len,
  };
}

/** Reassembler: feed HID reports, get complete messages out. */
export class FrameAssembler {
  private chunks: Uint8Array[] = [];
  private expectedIndex = 0;
  private started = false;
  private bytes = 0;
  private readonly maxMessage: number;

  constructor(maxMessage: number = 0xffff) {
    this.maxMessage = maxMessage;
  }

  /** Feed one report; returns an array of complete message byte arrays. */
  push(report: Uint8Array): Uint8Array[] {
    const frame = decodeFrame(report);
    if (!frame) return [];
    const out: Uint8Array[] = [];
    if (!this.started) {
      this.started = true;
      this.expectedIndex = frame.index;
      this.chunks = [];
      this.bytes = 0;
    }
    if (frame.index !== this.expectedIndex) {
      // out-of-order / lost frame — drop the partial message
      this.reset();
      if (frame.more) {
        this.started = true;
        this.expectedIndex = (frame.index + 1) & FRAME_INDEX_MASK;
        this.chunks = [frame.data];
        this.bytes = frame.data.length;
      } else {
        out.push(frame.data);
      }
      return out;
    }
    this.chunks.push(frame.data);
    this.bytes += frame.data.length;
    if (this.bytes > this.maxMessage) {
      this.reset();
      throw new ProtocolError('message exceeds maximum size', 'msg_overflow');
    }
    this.expectedIndex = (this.expectedIndex + 1) & FRAME_INDEX_MASK;
    if (!frame.more) {
      const size = this.chunks.reduce((a, c) => a + c.length, 0);
      const merged = new Uint8Array(size);
      let off = 0;
      for (const c of this.chunks) {
        merged.set(c, off);
        off += c.length;
      }
      this.reset();
      out.push(merged);
    }
    return out;
  }

  reset(): void {
    this.chunks = [];
    this.expectedIndex = 0;
    this.started = false;
    this.bytes = 0;
  }
}

/**
 * Split a raw byte stream (e.g. TCP transport) into AKP messages.
 * TCP framing: 2-byte little-endian length + raw HID frame bytes.
 */
export class StreamToFrames {
  private buf = Buffer.alloc(0);
  private readonly assembler = new FrameAssembler();

  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const messages: Uint8Array[] = [];
    while (this.buf.length >= 2) {
      const len = this.buf.readUInt16LE(0);
      if (len === 0) {
        this.buf = this.buf.subarray(2);
        continue;
      }
      if (this.buf.length < 2 + len) break;
      const frameBytes = this.buf.subarray(2, 2 + len);
      this.buf = this.buf.subarray(2 + len);
      messages.push(...this.assembler.push(frameBytes));
    }
    return messages;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
    this.assembler.reset();
  }
}

/**
 * Extract raw HID frame byte arrays from a length-prefixed stream
 * (the transport layer needs frames, not assembled messages).
 */
export class FrameStreamParser {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const frames: Uint8Array[] = [];
    while (this.buf.length >= 2) {
      const len = this.buf.readUInt16LE(0);
      if (len === 0) {
        this.buf = this.buf.subarray(2);
        continue;
      }
      if (this.buf.length < 2 + len) break;
      frames.push(this.buf.subarray(2, 2 + len));
      this.buf = this.buf.subarray(2 + len);
    }
    return frames;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

/** Encode one HID frame into TCP wire bytes (2-byte LE length + frame). */
export function frameToStream(frameBytes: Uint8Array): Buffer {
  const out = Buffer.alloc(2 + frameBytes.length);
  out.writeUInt16LE(frameBytes.length, 0);
  Buffer.from(frameBytes).copy(out, 2);
  return out;
}

/** Encode a full message into TCP wire bytes (frames + length prefixes). */
export function messageToStream(message: Uint8Array, mtu: number = MTU_DEFAULT): Buffer {
  const parts: Buffer[] = [];
  for (const f of frameMessage(message, mtu)) {
    parts.push(frameToStream(f.bytes));
  }
  return Buffer.concat(parts);
}
