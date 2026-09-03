import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentState, MsgType, MTU_QMK, MTU_ZMK, colorForState, hexToRgb, rgbToHex,
  crc8, crc16, frameMessage, decodeFrame, FrameAssembler, StreamToFrames,
  messageToStream, encodeMessage, decodeMessage, ProtocolError,
  buildCmd, buildState, buildHello, buildCaps, buildScreen, buildAck, buildRgb, buildRgbPerKey,
  parseCmd, parseState, parseHello, parseCaps, parseScreen, parseAck, parseRgb,
  encodeJsonMessage, buildHeartbeat, parseHeartbeat, buildLog, MAX_FRAME_DATA,
} from '../src/index';

describe('crc', () => {
  test('crc8 known vector (CRC-8/SMBUS check)', () => {
    assert.equal(crc8(new TextEncoder().encode('123456789')), 0xf4);
  });
  test('crc8 deterministic & order-sensitive', () => {
    assert.equal(crc8(Uint8Array.from([0xde, 0xad])), crc8(Uint8Array.from([0xde, 0xad])));
    assert.notEqual(crc8(Uint8Array.from([0xde, 0xad])), crc8(Uint8Array.from([0xad, 0xde])));
  });
  test('crc16 known vector (CCITT-FALSE check)', () => {
    const buf = new TextEncoder().encode('123456789');
    assert.equal(crc16(buf), 0x29b1);
  });
});

describe('colors', () => {
  test('default state colors match spec', () => {
    assert.deepEqual(colorForState(AgentState.IDLE), { r: 255, g: 255, b: 255 }); // white
    assert.deepEqual(colorForState(AgentState.THINKING), { r: 0, g: 120, b: 255 }); // blue
    assert.deepEqual(colorForState(AgentState.TOOL), { r: 150, g: 60, b: 220 }); // purple
    assert.deepEqual(colorForState(AgentState.WAITING), { r: 255, g: 140, b: 0 }); // orange
    assert.deepEqual(colorForState(AgentState.DONE), { r: 0, g: 220, b: 80 }); // green
    assert.deepEqual(colorForState(AgentState.ERROR), { r: 255, g: 40, b: 40 }); // red
    assert.deepEqual(colorForState(AgentState.DISCONNECTED), { r: 0, g: 0, b: 0 }); // off
  });
  test('hex conversions round-trip', () => {
    assert.equal(rgbToHex(hexToRgb('#ff8c00')), '#ff8c00');
    assert.deepEqual(hexToRgb('#0078ff'), { r: 0, g: 120, b: 255 });
  });
});

describe('message codec', () => {
  test('json message round-trip', () => {
    const msg = encodeJsonMessage(MsgType.STATE, { state: 'thinking', agent: 'codex' }, 7);
    const { message } = decodeMessage(msg);
    assert.equal(message.type, MsgType.STATE);
    assert.equal(message.seq, 7);
    assert.deepEqual(parseState(message), { state: 'thinking', agent: 'codex' });
  });
  test('empty payload message', () => {
    const msg = encodeMessage(MsgType.HEARTBEAT, null, 1);
    const { message } = decodeMessage(msg);
    assert.equal(message.payload.length, 0);
  });
  test('binary payload (per-key rgb)', () => {
    const leds = [{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }];
    const msg = buildRgbPerKey(leds, 3);
    const { message } = decodeMessage(msg);
    assert.equal(message.type, MsgType.RGB);
    assert.equal(message.payload[0], 0x01);
    assert.equal(new DataView(message.payload.buffer).getUint16(1, true), 2);
  });
  test('ack_requested flag round trip', () => {
    const msg = encodeJsonMessage(MsgType.CMD, { a: 1 }, 5, { ackRequested: true });
    const { message } = decodeMessage(msg);
    assert.equal(message.flags & 0x01, 0x01);
  });
  test('corrupt crc throws', () => {
    const msg = encodeJsonMessage(MsgType.STATE, { state: 'idle' }, 2);
    msg[msg.length - 1] ^= 0xff;
    assert.throws(() => decodeMessage(msg), ProtocolError);
  });
  test('incomplete message returns consumed 0', () => {
    const msg = encodeJsonMessage(MsgType.STATE, { state: 'idle', text: 'hello world' }, 2);
    const { consumed } = decodeMessage(msg.subarray(0, 6));
    assert.equal(consumed, 0);
  });
});

describe('frame codec', () => {
  const sample = new TextEncoder().encode(JSON.stringify({
    state: 'tool', agent: 'dsh', text: 'running a long payload that definitely exceeds one frame',
  }));

  test('fragmentation across qmk mtu (32)', () => {
    const frames = frameMessage(sample, MTU_QMK);
    assert.ok(frames.length >= 2, `expected >=2 frames, got ${frames.length}`);
    const asm = new FrameAssembler();
    const out: Uint8Array[] = [];
    for (const f of frames) out.push(...asm.push(f.bytes));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], sample);
  });

  test('single frame under zmk mtu (64)', () => {
    const small = new TextEncoder().encode(JSON.stringify({ state: 'idle', agent: 'claude' }));
    assert.ok(small.length < MAX_FRAME_DATA(MTU_ZMK));
    const frames = frameMessage(small, MTU_ZMK);
    assert.equal(frames.length, 1);
    const asm = new FrameAssembler();
    const out = asm.push(frames[0].bytes);
    assert.deepEqual(out[0], small);
  });

  test('decodeFrame tolerates leading report id', () => {
    const frames = frameMessage(sample, MTU_QMK);
    const withId = new Uint8Array(frames[0].bytes.length + 1);
    withId[0] = 0x00;
    withId.set(frames[0].bytes, 1);
    const decoded = decodeFrame(withId)!;
    assert.equal(decoded.consumed, frames[0].bytes.length + 1);
    assert.deepEqual(decoded.data, frames[0].data);
  });

  test('non-akp report returns null', () => {
    assert.equal(decodeFrame(Uint8Array.from([0x01, 0x00, 0x00, 0x00, 0x00])), null);
  });

  test('frame crc corruption detected', () => {
    const frames = frameMessage(sample, MTU_QMK);
    frames[0].bytes[frames[0].bytes.length - 1] ^= 0xff;
    const asm = new FrameAssembler();
    assert.throws(() => asm.push(frames[0].bytes), ProtocolError);
  });

  test('out-of-order frames drop partial message and resync', () => {
    const frames = frameMessage(sample, MTU_QMK);
    assert.ok(frames.length >= 3);
    const asm = new FrameAssembler();
    // feed frame 2 first (out of order) -> partial dropped, frame 2 starts new message tail
    const out1 = asm.push(frames[2].bytes);
    // then frame 3 (continues) then frame 0,1 — result message != original, but no throw
    asm.push(frames[3] ? frames[3].bytes : frames[0].bytes);
    const out2 = asm.push(frames[0].bytes);
    asm.push(frames[1].bytes);
    assert.ok(Array.isArray(out1) && Array.isArray(out2));
  });

  test('stream framing over tcp', () => {
    const stf = new StreamToFrames();
    const msg = encodeJsonMessage(MsgType.STATE, { state: 'done' }, 9);
    const wire = messageToStream(msg, MTU_QMK);
    // feed in weird chunk sizes
    let offset = 0;
    const out: Uint8Array[] = [];
    while (offset < wire.length) {
      const n = Math.min(7, wire.length - offset);
      out.push(...stf.push(wire.subarray(offset, offset + n)));
      offset += n;
    }
    assert.equal(out.length, 1);
    const { message } = decodeMessage(out[0]);
    assert.deepEqual(parseState(message), { state: 'done' });
  });
});

describe('typed builders', () => {
  test('cmd builder round-trip', () => {
    const wire = buildCmd({ action: 'approve', source: 'F13', ts: 123 }, 1);
    const { message } = decodeMessage(wire);
    assert.deepEqual(parseCmd(message), { action: 'approve', source: 'F13', ts: 123 });
  });
  test('state builder round-trip', () => {
    const wire = buildState({ state: 'waiting', agent: 'dsh', color: { r: 255, g: 140, b: 0 } }, 2);
    const { message } = decodeMessage(wire);
    assert.deepEqual(parseState(message), { state: 'waiting', agent: 'dsh', color: { r: 255, g: 140, b: 0 } });
  });
  test('hello/caps/screen/ack round trips', () => {
    const hello = buildHello({ proto: 1, fw: 'qmk', fw_version: '1.0.0', features: ['raw_hid', 'rgb_matrix', 'oled'] }, 1);
    assert.equal(parseHello(decodeMessage(hello).message).features.includes('rgb_matrix'), true);
    const caps = buildCaps({ proto: 1, features: ['rgb_matrix'], rgb: { per_key: true, led_count: 87, rgbw: false, brightness: 50 } }, 2);
    assert.equal(parseCaps(decodeMessage(caps).message).rgb!.led_count, 87);
    const screen = buildScreen({ lines: ['thinking...', 'step 2/5'] }, 3);
    assert.deepEqual(parseScreen(decodeMessage(screen).message).lines, ['thinking...', 'step 2/5']);
    const ack = buildAck(7, true);
    assert.equal(parseAck(decodeMessage(ack).message).ack_seq, 7);
    const rgb = buildRgb({ mode: 'solid', color: { r: 1, g: 2, b: 3 } }, 4);
    assert.equal(parseRgb(decodeMessage(rgb).message).mode, 'solid');
    const hb = buildHeartbeat({ t: 1700000000, state: 'idle' }, 5);
    assert.equal(parseHeartbeat(decodeMessage(hb).message).state, 'idle');
    const log = buildLog('hello');
    assert.equal(decodeMessage(log).message.type, MsgType.LOG);
  });
});
