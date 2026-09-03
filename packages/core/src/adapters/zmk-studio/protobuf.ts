/**
 * Minimal protobuf (proto3) codec — enough for the ZMK Studio RPC messages
 * used by the zmk-studio adapter. Supports varint, fixed32, string, bytes,
 * message, enum and oneof-style fields (message types carry their own tags).
 */

export type PbValue =
  | { kind: 'varint'; value: number | bigint }
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'message'; value: PbField[] };

export interface PbField {
  field: number;
  value: PbValue;
}

export function writeVarint(buf: number[], value: number | bigint): void {
  let v = BigInt(value);
  if (v < 0n) v = v + (1n << 64n); // two's complement for sint32/negative
  while (true) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      buf.push(byte);
      break;
    }
    buf.push(byte | 0x80);
  }
}

export function readVarint(bytes: Uint8Array, pos: number): { value: number; next: number } {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  while (i < bytes.length && shift < 64n) {
    const b = bytes[i];
    result |= BigInt(b & 0x7f) << shift;
    i += 1;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: Number(result), next: i };
}

export function zigzag(n: number): number {
  return (n << 1) ^ (n >> 31);
}

function writeField(buf: number[], field: PbField): void {
  const wireType =
    field.value.kind === 'message' ? 2 :
    field.value.kind === 'string' ? 2 :
    field.value.kind === 'bytes' ? 2 : 0;
  writeVarint(buf, (field.field << 3) | wireType);
  switch (field.value.kind) {
    case 'varint':
      writeVarint(buf, field.value.value);
      break;
    case 'string': {
      const raw = Buffer.from(field.value.value, 'utf8');
      writeVarint(buf, raw.length);
      for (const b of raw) buf.push(b);
      break;
    }
    case 'bytes': {
      writeVarint(buf, field.value.value.length);
      for (const b of field.value.value) buf.push(b);
      break;
    }
    case 'message': {
      const body: number[] = [];
      writeMessage(body, field.value.value);
      writeVarint(buf, body.length);
      for (const b of body) buf.push(b);
      break;
    }
  }
}

export function writeMessage(buf: number[], fields: PbField[]): void {
  for (const f of fields) writeField(buf, f);
}

export function pbEncode(fields: PbField[]): Uint8Array {
  const buf: number[] = [];
  writeMessage(buf, fields);
  return Uint8Array.from(buf);
}

function fieldSize(field: PbField): number {
  const wireType =
    field.value.kind === 'message' ? 2 :
    field.value.kind === 'string' ? 2 :
    field.value.kind === 'bytes' ? 2 : 0;
  let size = 0;
  // tag
  let tag = BigInt((field.field << 3) | wireType);
  size += tagBytes(tag);
  switch (field.value.kind) {
    case 'varint':
      size += varintBytes(field.value.value);
      break;
    case 'string': {
      const raw = Buffer.from(field.value.value, 'utf8');
      size += varintBytes(raw.length) + raw.length;
      break;
    }
    case 'bytes':
      size += varintBytes(field.value.value.length) + field.value.value.length;
      break;
    case 'message': {
      const inner = messageSize(field.value.value);
      size += varintBytes(inner) + inner;
      break;
    }
  }
  return size;
}

function tagBytes(v: bigint): number {
  let n = 0;
  do {
    v >>= 7n;
    n += 1;
  } while (v !== 0n);
  return n;
}

function varintBytes(v: number | bigint): number {
  let n = 0;
  let x = BigInt(v);
  if (x < 0n) x = x + (1n << 64n);
  do {
    x >>= 7n;
    n += 1;
  } while (x !== 0n);
  return n;
}

function messageSize(fields: PbField[]): number {
  let size = 0;
  for (const f of fields) {
    const inner = fieldSize(f);
    size += varintBytes(inner) + inner;
  }
  return size;
}

export function pbEncodeLengthDelimited(fields: PbField[]): Uint8Array {
  // not needed for our messages (no outer length-delimited wrapper) — kept for parity
  return pbEncode(fields);
}

export function pbDecode(bytes: Uint8Array): PbField[] {
  const fields: PbField[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const tag = readVarint(bytes, pos);
    pos = tag.next;
    const field = tag.value >>> 3;
    const wireType = tag.value & 0x07;
    if (field === 0) break;
    if (wireType === 0) {
      const v = readVarint(bytes, pos);
      pos = v.next;
      fields.push({ field, value: { kind: 'varint', value: v.value } });
    } else if (wireType === 2) {
      const len = readVarint(bytes, pos);
      pos = len.next;
      const start = pos;
      const end = start + len.value;
      if (end > bytes.length) break;
      const raw = bytes.subarray(start, end);
      pos = end;
      fields.push({ field, value: { kind: 'bytes', value: Uint8Array.from(raw) } });
    } else {
      break; // unsupported wire type (3,4,5) — stop parsing
    }
  }
  return fields;
}

export function pbGet(fields: PbField[], field: number): PbValue | undefined {
  return fields.find((f) => f.field === field)?.value;
}

export function pbAsVarint(v: PbValue | undefined): number | undefined {
  return v?.kind === 'varint' ? Number(v.value) : undefined;
}

export function pbAsString(v: PbValue | undefined): string | undefined {
  if (v?.kind === 'bytes') return Buffer.from(v.value).toString('utf8');
  if (v?.kind === 'string') return v.value;
  return undefined;
}

export function pbAsMessage(v: PbValue | undefined): PbField[] | undefined {
  if (v?.kind === 'message') return v.value;
  if (v?.kind === 'bytes') return pbDecode(v.value);
  return undefined;
}

/** encode a nested message field: tag(field,2) + len + body */
export function pbNested(field: number, inner: PbField[]): PbField {
  const body = pbEncode(inner);
  return { field, value: { kind: 'bytes', value: body } };
}
