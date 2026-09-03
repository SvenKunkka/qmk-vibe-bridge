/**
 * Ask-policy confirmation tests (round-16 P2-6): real human confirmation with
 * one-time, payload-bound, expiring tokens. No confirmation => zero writes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WriteAudit } from '../src/capabilities/audit';
import { CapabilityGate } from '../src/capabilities/gate';
import { ProfileRegistry } from '../src/profiles/registry';
import { DeviceManager } from '../src/devices/manager';
import { NullTransport, type TransportHandlers } from '../src/transports/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * NullTransport that auto-responds to the simulator protocol: after any
 * inbound write it delivers a resp:sim:hello so the simulator adapter
 * identifies immediately (no TCP server needed).
 */
class SimAutoTransport extends NullTransport {
  responded = false;
  override setHandlers(h: TransportHandlers): void {
    super.setHandlers(h);
    if (!this.responded) {
      this.responded = true;
      setTimeout(() => {
        this.deliver(Uint8Array.from(Buffer.from('{"type":"resp:sim:hello","role":"simulator-keyboard"}\n', 'utf8')));
      }, 20);
    }
  }
}

async function makeHarness(confirmationTtlMs = 60_000) {
  const audit = new WriteAudit();
  const gate = new CapabilityGate(audit, 'ask'); gate.setWritesDisabled(false);
  const reg = new ProfileRegistry();
  const t = new SimAutoTransport({ id: 'sim', exactPath: 'tcp://127.0.0.1:1' });
  const dm = new DeviceManager({
    registry: reg,
    audit,
    gate,
    confirmationTtlMs,
    enumerators: [async () => [{ id: 'sim', label: 'Sim KB', kind: 'tcp', path: 'tcp://127.0.0.1:1' }]],
    openTransport: async () => t,
  });
  await dm.refresh();
  reg.assignProfile('tcp://127.0.0.1:1', 'simulator');
  const dev = await dm.connect('sim', 'simulator');
  assert.equal(dev.status, 'ready', `expected ready, got ${dev.status}`);
  dm.setUserWriteEnabled('sim', true);
  return { dm, audit, t };
}

const indOp = (payload: { color: { r: number; g: number; b: number } } = { color: { r: 255, g: 0, b: 0 } }) => ({
  kind: 'set-indicator' as const,
  deviceId: 'sim',
  label: 'indicator red',
  payload,
});

describe('round-16 P2-6: ask policy confirmation', () => {
  test('unconfirmed op: zero writes, needsConfirmation with full summary', async () => {
    const { dm, audit, t } = await makeHarness();
    // baseline: the identify handshake wrote its sim:hello request
    const writesBefore = t.written.length;
    const res = await dm.applyOp(indOp());
    assert.equal(res.ok, false);
    const c = res as { needsConfirmation?: boolean; confirmationToken?: string; summary?: Record<string, unknown> };
    assert.equal(c.needsConfirmation, true);
    assert.ok(c.confirmationToken, 'token issued');
    assert.ok(c.summary, 'summary present');
    assert.equal(c.summary?.deviceId, 'sim');
    assert.equal(c.summary?.capability, 'set-indicator');
    assert.equal(c.summary?.adapter, 'simulator');
    assert.equal(c.summary?.profileId, 'simulator');
    assert.ok(String(c.summary?.payloadHash ?? '').length === 64, 'payload hash present');
    assert.equal(audit.countWrites(), 0, 'no writes before confirmation');
    assert.equal(t.written.length, writesBefore, 'no new bytes on the wire for the unconfirmed op');
    await dm.disconnect('sim');
  });

  test('confirm once: executes exactly once; second use of the token is rejected', async () => {
    const { dm, audit } = await makeHarness();
    const first = await dm.applyOp(indOp());
    const c = first as { confirmationToken: string };
    const ok1 = await dm.confirmOp(c.confirmationToken);
    assert.equal(ok1.ok, true, 'confirmation executes the op');
    assert.equal(audit.countWrites(), 1, 'exactly one write after confirmation');
    const ok2 = await dm.confirmOp(c.confirmationToken);
    assert.equal(ok2.ok, false, 'token is one-time');
    assert.ok(ok2.error?.includes('consumed') || ok2.error?.includes('unknown'), ok2.error);
    assert.equal(audit.countWrites(), 1, 'no second write');
    await dm.disconnect('sim');
  });

  test('payload change at confirm time is rejected (token bound to payload hash)', async () => {
    const { dm, audit } = await makeHarness();
    const first = await dm.applyOp(indOp());
    const c = first as { confirmationToken: string };
    const changed = await dm.confirmOp(c.confirmationToken, indOp({ color: { r: 0, g: 0, b: 255 } }));
    assert.equal(changed.ok, false);
    assert.ok(changed.error?.includes('payload mismatch'), changed.error);
    assert.equal(audit.countWrites(), 0);
    // the same token with the CORRECT payload still works (bound, not consumed)
    const ok = await dm.confirmOp(c.confirmationToken, indOp());
    assert.equal(ok.ok, true);
    assert.equal(audit.countWrites(), 1);
    await dm.disconnect('sim');
  });

  test('expired token is rejected', async () => {
    const { dm, audit } = await makeHarness(100); // 100ms ttl
    const first = await dm.applyOp(indOp());
    const c = first as { confirmationToken: string };
    await sleep(200);
    const res = await dm.confirmOp(c.confirmationToken);
    assert.equal(res.ok, false);
    assert.ok(res.error?.includes('expired'), res.error);
    assert.equal(audit.countWrites(), 0);
    await dm.disconnect('sim');
  });
});
