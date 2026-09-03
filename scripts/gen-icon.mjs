#!/usr/bin/env node
/**
 * Generate the app icon (1024x1024 PNG) without any image library:
 * a rounded dark tile with the three agent-status dots (idle white,
 * thinking blue, tool purple) and a keyboard-bar motif.
 * Usage: node scripts/gen-icon.mjs <out.png>
 */

import * as zlib from 'node:zlib';
import * as fs from 'node:fs';
import * as path from 'node:path';

const W = 1024;
const H = 1024;
const out = process.argv[2] ?? 'app/build/icon.png';

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// RGBA buffer, rounded-rect background + dots
const px = Buffer.alloc(W * H * 4);
const bg = [16, 19, 24, 255];
const radius = 200;
const dotColors = [
  [255, 255, 255], // idle white
  [0, 120, 255], // thinking blue
  [150, 60, 220], // tool purple
];

function inRoundedRect(x, y, rw, rh, r) {
  const dx = Math.max(r - x, x - (rw - r), 0);
  const dy = Math.max(r - y, y - (rh - r), 0);
  return dx * dx + dy * dy <= r * r;
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (inRoundedRect(x, y, W, H, radius)) {
      px[i] = bg[0];
      px[i + 1] = bg[1];
      px[i + 2] = bg[2];
      px[i + 3] = bg[3];
    } else {
      px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; // transparent
    }
  }
}

// three status dots across the middle + a keyboard bar
const cy = 430;
const dotR = 110;
for (let d = 0; d < 3; d++) {
  const cx = 512 + (d - 1) * 260;
  for (let y = cy - dotR; y < cy + dotR; y++) {
    for (let x = cx - dotR; x < cx + dotR; x++) {
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= dotR * dotR) {
        const i = (y * W + x) * 4;
        const [r, g, b] = dotColors[d];
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = 255;
      }
    }
  }
}

// keyboard bar under the dots
const barY0 = 690;
const barH = 70;
const barX0 = 260;
const barX1 = 764;
const barR = 35;
for (let y = barY0; y < barY0 + barH; y++) {
  for (let x = barX0; x <= barX1; x++) {
    if (inRoundedRect(x - barX0, y - barY0, barX1 - barX0, barH, barR)) {
      const i = (y * W + x) * 4;
      px[i] = 90;
      px[i + 1] = 99;
      px[i + 2] = 112;
      px[i + 3] = 255;
    }
  }
}

// raw scanlines with filter byte 0
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// compression, filter, interlace = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('icon written:', out, png.length, 'bytes');
