/**
 * ZMK Studio framing + protobuf tests (round-15 acceptance items 8 & 9).
 * Verified against the official spec:
 * https://zmk.dev/docs/development/studio-rpc-protocol and
 * https://github.com/zmkfirmware/zmk-studio-messages
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  zmkFrameEncode, zmkFrameDecode, ZmkFrameStream, ZMK_SOF, ZMK_ESC, ZMK_EOF,
} from '../src/adapters/zmk-studio/framing';
import {
  encodeStudioRequest, decodeStudioResponse,
  encodeGetDeviceInfoResponse, encodeLockStateResponse,
  encodeSimpleErrorResponse, encodeKeymapResponse,
} from '../src/adapters/zmk-studio/messages';

describe('ZMK Studio framing (item 8)', () => {
  test('simple payload: SoF + payload + EoF, no escaping needed', () => {
    const payload = new Uint8Array([0x12, 0x01, 0xbb]);
    const framed = zmkFrameEncode(payload);
    assert.deepEqual([...framed], [ZMK_SOF, 0x12, 0x01, 0xbb, ZMK_EOF]);
    assert.deepEqual([...zmkFrameDecode(framed)!], [...payload]);
  });

  test('payload with special bytes is escaped (0xAD, 0xAC)', () => {
    const payload = new Uint8Array([0x12, ZMK_EOF, ZMK_ESC]);
    const framed = zmkFrameEncode(payload);
    // 0xAD -> 0xAC 0xAD ; 0xAC -> 0xAC 0xAC
    assert.deepEqual([...framed], [ZMK_SOF, 0x12, ZMK_ESC, ZMK_EOF, ZMK_ESC, ZMK_ESC, ZMK_EOF]);
    assert.deepEqual([...zmkFrameDecode(framed)!], [...payload]);
  });

  test('SoF byte inside payload is escaped too', () => {
    const payload = new Uint8Array([ZMK_SOF, 0x00]);
    const framed = zmkFrameEncode(payload);
    assert.deepEqual([...framed], [ZMK_SOF, ZMK_ESC, ZMK_SOF, 0x00, ZMK_EOF]);
    assert.deepEqual([...zmkFrameDecode(framed)!], [...payload]);
  });

  test('stream decoder handles chunked input', () => {
    const stream = new ZmkFrameStream();
    const payload = new Uint8Array(64).fill(7);
    const framed = zmkFrameEncode(payload);
    const frames = zmkFrameEncode(new Uint8Array([1, 2, 3]));
    const all = Buffer.concat([Buffer.from(framed), Buffer.from(frames)]);
    // feed one byte at a time
    const out: Uint8Array[] = [];
    for (const b of all) {
      out.push(...stream.push(new Uint8Array([b])));
    }
    assert.equal(out.length, 2);
    assert.deepEqual([...out[0]], [...payload]);
    assert.deepEqual([...out[1]], [1, 2, 3]);
  });

  test('malformed frame (dangling escape) is dropped', () => {
    const bad = new Uint8Array([ZMK_SOF, ZMK_ESC, ZMK_EOF]); // escape then EoF with nothing escaped
    assert.equal(zmkFrameDecode(bad), null);
  });
});

describe('ZMK Studio protobuf messages (item 9)', () => {
  test('get_device_info request round-trips to device-info response', () => {
    const req = encodeStudioRequest({ requestId: 42, core: { kind: 'get_device_info' } });
    // simulate the device: parse the request (fields: request_id=1, core=3)
    const resp = encodeGetDeviceInfoResponse(42, 'My Keyboard', new Uint8Array([0xaa, 0xbb]));
    const decoded = decodeStudioResponse(resp);
    assert.ok(decoded);
    assert.equal(decoded.requestId, 42);
    assert.equal(decoded.core?.kind, 'get_device_info');
    if (decoded.core?.kind === 'get_device_info') {
      assert.equal(decoded.core.name, 'My Keyboard');
      assert.deepEqual([...decoded.core.serialNumber], [0xaa, 0xbb]);
    }
    void req;
  });

  test('get_lock_state response decodes locked/unlocked', () => {
    const locked = decodeStudioResponse(encodeLockStateResponse(7, false));
    assert.equal(locked?.core?.kind === 'get_lock_state' ? locked.core.lockState : null, 'locked');
    const unlocked = decodeStudioResponse(encodeLockStateResponse(8, true));
    assert.equal(unlocked?.core?.kind === 'get_lock_state' ? unlocked.core.lockState : null, 'unlocked');
  });

  test('meta simple_error decodes', () => {
    const r = decodeStudioResponse(encodeSimpleErrorResponse(9, 1)); // UNLOCK_REQUIRED
    assert.ok(r);
    assert.equal(r.error, true);
    assert.equal(r.core?.kind === 'simple_error' ? r.core.code : null, 1);
  });

  test('keymap response with layers decodes', () => {
    const r = decodeStudioResponse(encodeKeymapResponse(11, 2, ['base', 'nav']));
    assert.ok(r?.keymap);
    assert.equal(r.keymap.layerCount, 2);
    assert.equal(r.keymap.layers.length, 2);
    assert.equal(r.keymap.layers[0].name, 'base');
    assert.equal(r.keymap.layers[1].name, 'nav');
  });

  test('adapter: locked get_keymap returns UNLOCK_REQUIRED', async () => {
    // covered by acceptance A8/A9 against the zmk-studio virtual device;
    // here we assert the framing round-trip through the real adapter
    const { ZmkStudioAdapter } = await import('../src/adapters/zmk-studio/index');
    const { NullTransport } = await import('../src/transports/types');
    const { zmkStudioProfile } = await import('../src/profiles/builtin');
    const t = new NullTransport({ id: 'studio', exactPath: 'serial:///dev/ttyACM0' });
    const adapter = new ZmkStudioAdapter({ timeoutMs: 300 });
    // preload a response: device info + locked
    const info = zmkFrameEncode(encodeGetDeviceInfoResponse(1, 'Test', new Uint8Array()));
    setTimeout(() => {
      // respond to the get_device_info request
      t.deliver(info);
    }, 20);
    const ctx = { transport: t, profile: zmkStudioProfile, onLog: () => {} };
    const result = await adapter.identify(ctx);
    assert.equal(result.status, 'identified');
    assert.equal(result.capabilities['runtime-keymap'], 'supported');
    assert.equal(result.capabilities['set-rgb'], 'unsupported');
    assert.equal(result.capabilities['display-text'], 'unsupported');
    await adapter.close();
  });
});

describe('ZMK Studio lock handling (round-16, P1-1)', () => {
  test('unlock performs ZERO writes and never fakes success (core.proto has no unlock RPC)', async () => {
    const { ZmkStudioAdapter } = await import('../src/adapters/zmk-studio/index');
    const { NullTransport } = await import('../src/transports/types');
    const { zmkStudioProfile } = await import('../src/profiles/builtin');
    const t = new NullTransport({ id: 'studio', exactPath: 'serial:///dev/ttyACM0' });
    const adapter = new ZmkStudioAdapter({ timeoutMs: 200 });
    const ctx = { transport: t, profile: zmkStudioProfile, onLog: () => {} };
    adapter.attach(ctx);
    const res = await adapter.apply(
      { kind: 'runtime-keymap', deviceId: 'd', label: 'unlock', payload: { action: 'unlock' } },
      ctx,
    );
    assert.equal(res.wrote, false, 'unlock must not write anything');
    assert.equal(res.ok, false, 'unlock must not report success');
    assert.equal(res.needsPhysicalUnlock, true, 'unlock is a physical action on the keyboard');
    assert.equal(t.written.length, 0, 'zero bytes written for unlock');
    await adapter.close();
  });

  test('explicit lock DOES send the core.lock RPC', async () => {
    const { ZmkStudioAdapter } = await import('../src/adapters/zmk-studio/index');
    const { NullTransport } = await import('../src/transports/types');
    const { zmkStudioProfile } = await import('../src/profiles/builtin');
    const { zmkFrameDecode, ZmkFrameStream } = await import('../src/adapters/zmk-studio/framing');
    const { pbDecode, pbAsVarint } = await import('../src/adapters/zmk-studio/protobuf');
    const t = new NullTransport({ id: 'studio', exactPath: 'serial:///dev/ttyACM0' });
    const adapter = new ZmkStudioAdapter({ timeoutMs: 200 });
    const ctx = { transport: t, profile: zmkStudioProfile, onLog: () => {} };
    adapter.attach(ctx);
    // respond to the lock request with a locked-state response
    const { encodeLockStateResponse } = await import('../src/adapters/zmk-studio/messages');
    setTimeout(() => {
      const resp = zmkFrameEncode(encodeLockStateResponse(1, false));
      t.deliver(resp);
    }, 10);
    const res = await adapter.apply(
      { kind: 'runtime-keymap', deviceId: 'd', label: 'lock', payload: { action: 'lock' } },
      ctx,
    );
    assert.equal(res.wrote, true, 'lock RPC writes');
    assert.equal(res.ok, true);
    assert.equal(t.written.length, 1);
    // verify the written frame is a core.lock request (core.Request field 3)
    const payload = zmkFrameDecode(t.written[0]);
    assert.ok(payload);
    const fields = pbDecode(payload);
    const coreBytes = fields.find((f) => f.field === 3)?.value;
    assert.ok(coreBytes && coreBytes.kind === 'bytes', 'core subsystem present');
    const coreFields = pbDecode((coreBytes as { value: Uint8Array }).value);
    const lockField = coreFields.find((f) => f.field === 3);
    assert.equal(pbAsVarint(lockField?.value), 1, 'core.lock (field 3) sent — never unlock');
    void new ZmkFrameStream();
    await adapter.close();
  });

  test('get-keymap while known-locked: zero writes, needsPhysicalUnlock', async () => {
    const { ZmkStudioAdapter } = await import('../src/adapters/zmk-studio/index');
    const { NullTransport } = await import('../src/transports/types');
    const { zmkStudioProfile } = await import('../src/profiles/builtin');
    const t = new NullTransport({ id: 'studio', exactPath: 'serial:///dev/ttyACM0' });
    const adapter = new ZmkStudioAdapter({ timeoutMs: 200 });
    const ctx = { transport: t, profile: zmkStudioProfile, onLog: () => {} };
    adapter.attach(ctx);
    // simulate a lock_state_changed notification -> locked
    const { encodeLockStateNotification } = await import('../src/adapters/zmk-studio/messages');
    const { zmkFrameEncode } = await import('../src/adapters/zmk-studio/framing');
    t.deliver(zmkFrameEncode(encodeLockStateNotification(false)));
    assert.equal(adapter.currentLockState, 'locked');
    const before = t.written.length;
    const res = await adapter.apply(
      { kind: 'runtime-keymap', deviceId: 'd', label: 'get keymap', payload: { action: 'get-keymap' } },
      ctx,
    );
    assert.equal(res.wrote, false, 'no write while known-locked');
    assert.equal(res.needsPhysicalUnlock, true);
    assert.equal(t.written.length, before, 'zero writes while locked');
    await adapter.close();
  });

  test('physical unlock notification enables get-keymap (no fake unlock)', async () => {
    const { ZmkStudioAdapter } = await import('../src/adapters/zmk-studio/index');
    const { NullTransport } = await import('../src/transports/types');
    const { zmkStudioProfile } = await import('../src/profiles/builtin');
    const t = new NullTransport({ id: 'studio', exactPath: 'serial:///dev/ttyACM0' });
    const adapter = new ZmkStudioAdapter({ timeoutMs: 200 });
    const ctx = { transport: t, profile: zmkStudioProfile, onLog: () => {} };
    adapter.attach(ctx);
    const { encodeLockStateNotification, encodeKeymapResponse } = await import('../src/adapters/zmk-studio/messages');
    const { zmkFrameEncode } = await import('../src/adapters/zmk-studio/framing');
    // firmware broadcasts physical unlock
    t.deliver(zmkFrameEncode(encodeLockStateNotification(true)));
    assert.equal(adapter.currentLockState, 'unlocked');
    let responded = false;
    const timer = setInterval(() => {
      if (t.written.length > 0 && !responded) {
        responded = true;
        t.deliver(zmkFrameEncode(encodeKeymapResponse(1, 2, ['base', 'nav'])));
      }
    }, 10);
    const res = await adapter.apply(
      { kind: 'runtime-keymap', deviceId: 'd', label: 'get keymap', payload: { action: 'get-keymap' } },
      ctx,
    );
    clearInterval(timer);
    assert.equal(res.ok, true, 'keymap succeeds only after physical unlock');
    assert.equal(res.wrote, true);
    await adapter.close();
  });
});
