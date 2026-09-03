/**
 * VIA lighting tests (round-17 acceptance E): official wire [0x07/0x08,
 * channel, value_id, data], echo + readback verification, sent-unverified
 * semantics. No "applied" without readback.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ViaAdapter, VIA_CMD_CUSTOM_GET_VALUE, VIA_CMD_CUSTOM_SET_VALUE, VIA_CHANNEL_RGBLIGHT } from '../src/adapters/via';
import { NullTransport } from '../src/transports/types';
import { viaProfile } from '../src/profiles/builtin';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeViaOptions {
  channels?: number[];
  /** if true, do not answer readback (sent-unverified path) */
  noReadback?: boolean;
  /** respond to set with unhandled (0xFF) */
  setUnhandled?: boolean;
  /** respond to get with a different value (mismatch) */
  readbackMismatch?: boolean;
}

/** NullTransport speaking the official VIA lighting wire (answers EVERY write). */
class FakeViaTransport extends NullTransport {
  private readonly opts: Required<FakeViaOptions>;
  private state = new Map<string, number>();
  constructor(opts: FakeViaOptions = {}) {
    super({ id: 'via', exactPath: 'DevSrvsID:via', mtu: 32 });
    this.opts = { channels: [1, 2, 3], noReadback: false, setUnhandled: false, readbackMismatch: false, ...opts };
  }
  override write(bytes: Uint8Array): Promise<void> {
    const p = super.write(bytes);
    setTimeout(() => this.handleReport(bytes), 10);
    return p;
  }
  private handleReport(raw: Uint8Array): void {
    const report = raw.length >= 32 ? raw.subarray(0, 32) : raw;
    const cmd = report[0];
    const reply = new Uint8Array(32);
    if (cmd === 0x01) {
      reply[0] = 0x01; reply[1] = 0x00; reply[2] = 0x0d;
      this.deliver(reply);
    } else if (cmd === 0x07) {
      if (this.opts.setUnhandled || !this.opts.channels.includes(report[1])) {
        reply[0] = 0xff;
      } else {
        reply.set(report.subarray(0, 3), 0);
        for (let i = 3; i < report.length; i++) this.state.set(`c${report[1]}:v${report[2]}:${i - 3}`, report[i]);
        reply.set(report.subarray(0, Math.min(report.length, 8)), 0);
      }
      this.deliver(reply);
    } else if (cmd === 0x08) {
      if (this.opts.noReadback) return; // no readback at all
      if (!this.opts.channels.includes(report[1])) {
        reply[0] = 0xff;
        this.deliver(reply);
        return;
      }
      reply.set(report.subarray(0, 3), 0);
      if (this.opts.readbackMismatch) {
        reply[3] = 0; reply[4] = 0; // mismatch with what was set
      } else {
        for (let i = 0; i < 4; i++) {
          const v = this.state.get(`c${report[1]}:v${report[2]}:${i}`);
          reply[3 + i] = v !== undefined ? v : i === 0 ? 255 : i === 1 && report[2] === 4 ? 170 : 255;
        }
      }
      this.deliver(reply);
    }
  }
}

async function make(opts: FakeViaOptions = {}) {
  const t = new FakeViaTransport(opts);
  const adapter = new ViaAdapter();
  const ctx = { transport: t, profile: viaProfile, onLog: () => {} };
  adapter.attach(ctx);
  return { t, adapter, ctx };
}

const redOp = { kind: 'set-rgb' as const, deviceId: 'd', label: 'red', payload: { mode: 'solid', color: { r: 255, g: 0, b: 0 } } };
const brightnessOp = { kind: 'set-backlight' as const, deviceId: 'd', label: 'brightness 100', payload: { mode: 'solid', brightness: 100 } };

describe('round-17 E: VIA lighting', () => {
  test('set-rgb with echo + readback -> applied, official channel 2', async () => {
    const { adapter, ctx, t } = await make();
    const res = await adapter.apply(redOp, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.result, 'applied');
    assert.equal(res.wrote, true);
    // the set report must be [0x07, 2, 4, hue, sat]
    const setReport = t.written.find((w) => w[0] === VIA_CMD_CUSTOM_SET_VALUE);
    assert.ok(setReport, 'a custom-set report was written');
    assert.equal(setReport[1], VIA_CHANNEL_RGBLIGHT);
    assert.equal(setReport[2], 4);
    assert.equal(setReport[3], 0, 'red hue = 0');
    await adapter.close();
  });

  test('set-backlight brightness 100 -> applied with readback', async () => {
    const { adapter, ctx } = await make();
    const res = await adapter.apply(brightnessOp, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.result, 'applied');
    await adapter.close();
  });

  test('timeout (no echo) -> failed, wrote=true, never applied', async () => {
    // a transport that never answers
    const t = new NullTransport({ id: 'v', exactPath: 'P', mtu: 32 });
    const adapter = new ViaAdapter();
    const ctx = { transport: t, profile: viaProfile, onLog: () => {} };
    adapter.attach(ctx);
    const res = await adapter.apply(redOp, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.result, 'failed');
    assert.equal(res.wrote, true);
    assert.ok(res.error?.includes('echo'));
    await adapter.close();
  });

  test('channel unsupported (0xFF unhandled) -> failed', async () => {
    const { adapter, ctx } = await make({ channels: [1] }); // no rgblight
    const res = await adapter.apply(redOp, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.result, 'failed');
    await adapter.close();
  });

  test('wrong value readback -> failed (not applied)', async () => {
    const { adapter, ctx } = await make({ readbackMismatch: true });
    const res = await adapter.apply(redOp, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.result, 'failed');
    assert.ok(res.error?.includes('readback mismatch'));
    await adapter.close();
  });

  test('sent-unverified: valid echo but no readback', async () => {
    const { adapter, ctx } = await make({ noReadback: true });
    const res = await adapter.apply(redOp, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.result, 'sent-unverified');
    assert.ok(res.error?.includes('sent but not verified'));
    await adapter.close();
  });

  test('probe: channels respond -> capabilities supported; missing -> unsupported', async () => {
    const { adapter, ctx } = await make({ channels: [1, 2] }); // no rgb_matrix
    const probe = await adapter.probeLightingChannels(ctx, 200);
    assert.equal(probe.backlight, true);
    assert.equal(probe.rgblight, true);
    assert.equal(probe.rgbMatrix, false);
    void sleep;
  });
});
