/**
 * ZMK Studio message framing (round-15), per the official ZMK Studio RPC
 * Protocol (https://zmk.dev/docs/development/studio-rpc-protocol):
 *
 *   SoF  = 0xAB   Start of Frame
 *   Esc  = 0xAC   Escape
 *   EoF  = 0xAD   End of Frame
 *
 * A message is SoF + payload (special bytes escaped with Esc) + EoF.
 */

export const ZMK_SOF = 0xab;
export const ZMK_ESC = 0xac;
export const ZMK_EOF = 0xad;

export function zmkFrameEncode(payload: Uint8Array): Uint8Array {
  const out: number[] = [ZMK_SOF];
  for (const b of payload) {
    if (b === ZMK_SOF || b === ZMK_ESC || b === ZMK_EOF) {
      out.push(ZMK_ESC);
    }
    out.push(b);
  }
  out.push(ZMK_EOF);
  return Uint8Array.from(out);
}

export function zmkFrameDecode(framed: Uint8Array): Uint8Array | null {
  if (framed.length < 2) return null;
  if (framed[0] !== ZMK_SOF || framed[framed.length - 1] !== ZMK_EOF) return null;
  const out: number[] = [];
  let i = 1;
  while (i < framed.length - 1) {
    const b = framed[i];
    if (b === ZMK_ESC) {
      i += 1;
      if (i >= framed.length - 1) return null; // dangling escape
      out.push(framed[i]);
    } else {
      out.push(b);
    }
    i += 1;
  }
  return Uint8Array.from(out);
}

/**
 * Streaming decoder: feed raw bytes (serial chunks / GATT indications),
 * receive complete unescaped payloads. Malformed frames are skipped.
 */
export class ZmkFrameStream {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const out: Uint8Array[] = [];
    while (true) {
      const start = this.buf.indexOf(ZMK_SOF);
      if (start < 0) {
        // no SoF in buffer; keep only trailing bytes in case a SoF spans
        // a chunk boundary
        this.buf = this.buf.length > 1 ? this.buf.subarray(-1) : this.buf;
        break;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < 2) break;
      const eof = this.buf.indexOf(ZMK_EOF, 1);
      if (eof < 0) break; // wait for more bytes
      const framed = this.buf.subarray(0, eof + 1);
      this.buf = this.buf.subarray(eof + 1);
      const payload = zmkFrameDecode(framed);
      if (payload) out.push(payload);
      // if decode failed (dangling escape), drop the frame and continue
    }
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
