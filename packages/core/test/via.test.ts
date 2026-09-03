/**
 * VIA adapter tests (round-16 P2-5): set-keycode must round-trip and validate
 * the protocol echo — no fake success on unverified writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ViaAdapter, viaReport, VIA_CMD_DYNAMIC_KEYMAP_SET_KEYCODE } from '../src/adapters/via';
import { NullTransport } from '../src/transports/types';
import { viaProfile } from '../src/profiles/builtin';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function op(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'runtime-keymap' as const,
    deviceId: 'd',
    label: 'set keycode',
    payload: { action: 'set-keycode', layer: 1, row: 2, col: 3, keycode: 0x1a2b, ...overrides },
  };
}

async function makeAdapter() {
  const t = new NullTransport({ id: 'via', exactPath: 'DevSrvsID:via', mtu: 32 });
  const adapter = new ViaAdapter();
  const ctx = { transport: t, profile: viaProfile, onLog: () => {} };
  adapter.attach(ctx);
  return { t, adapter, ctx };
}

describe('round-16 P2-5: VIA set-keycode echo validation', () => {
  test('success: valid echo of cmd+layer/row/col/keycode -> ok, wrote', async () => {
    const { t, adapter, ctx } = await makeAdapter();
    const report = viaReport(VIA_CMD_DYNAMIC_KEYMAP_SET_KEYCODE, [1, 2, 3, 0x1a, 0x2b]);
    setTimeout(() => t.deliver(report), 10); // perfect echo
    const res = await adapter.apply(op(), ctx);
    assert.equal(res.ok, true);
    assert.equal(res.wrote, true);
    await adapter.close();
  });

  test('timeout: no echo -> fail, wrote=true (wire write happened), no fake success', async () => {
    const { t, adapter, ctx } = await makeAdapter();
    const res = await adapter.apply(op(), ctx); // nothing responds
    assert.equal(res.ok, false, 'no fake success on timeout');
    assert.equal(res.wrote, true, 'the report did reach the wire (audited)');
    assert.ok(res.error?.includes('echo'), `error explains echo failure: ${res.error}`);
    assert.equal(t.written.length, 1, 'exactly one report written');
    await adapter.close();
  });

  test('wrong command echo -> fail (roundTrip does not match a different cmd)', async () => {
    const { t, adapter, ctx } = await makeAdapter();
    const wrong = viaReport(0x99, [1, 2, 3, 0x1a, 0x2b]);
    setTimeout(() => t.deliver(wrong), 10);
    const res = await adapter.apply(op(), ctx);
    assert.equal(res.ok, false, 'echo with wrong command id must fail');
    await adapter.close();
  });

  test('wrong keycode echo -> fail (payload mismatch)', async () => {
    const { t, adapter, ctx } = await makeAdapter();
    // echo has cmd + layer/row/col correct but a DIFFERENT keycode
    const wrongKeycode = viaReport(VIA_CMD_DYNAMIC_KEYMAP_SET_KEYCODE, [1, 2, 3, 0x00, 0x01]);
    setTimeout(() => t.deliver(wrongKeycode), 10);
    const res = await adapter.apply(op(), ctx);
    assert.equal(res.ok, false, 'keycode mismatch must fail');
    assert.ok(res.error?.includes('echo') || res.error?.includes('mismatch'), res.error);
    await adapter.close();
  });

  test('wrong layer echo -> fail', async () => {
    const { t, adapter, ctx } = await makeAdapter();
    const wrongLayer = viaReport(VIA_CMD_DYNAMIC_KEYMAP_SET_KEYCODE, [9, 2, 3, 0x1a, 0x2b]);
    setTimeout(() => t.deliver(wrongLayer), 10);
    const res = await adapter.apply(op(), ctx);
    assert.equal(res.ok, false, 'layer mismatch must fail');
    await adapter.close();
  });

  test('audit perspective: wrote=true records a real wire write; UI gets ok=false', async () => {
    const { t, adapter, ctx } = await makeAdapter();
    const res = await adapter.apply(op(), ctx); // no echo -> timeout
    assert.equal(res.wrote, true);
    assert.equal(res.ok, false);
    await adapter.close();
    void sleep;
  });
});
