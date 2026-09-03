/**
 * unknown-rawhid-readonly-test (round-15, generic — replaces the old
 * vendor-specific terminal verification).
 *
 * Purpose: verify the SAFETY contract for ANY connected Raw HID interface
 * that does not match a verified control profile. No vendor names, no VID/PID
 * product conclusions, no data is ever sent, and the write count must stay 0.
 *
 * Contract under test (round-15):
 *   - 0xFF60/0x61 interface -> qmk-rawhid-looking, transport-available,
 *     capabilities-unknown (never ready, never "unsupported");
 *   - no AKP HELLO is expected and no "firmware incompatible" verdict exists;
 *   - no probe packets are sent to unknown Raw HID endpoints;
 *   - after AI events AND an explicit op attempt, writes to the device = 0.
 *
 * Run:  npx tsx scripts/unknown-rawhid-readonly-test.ts   (from the repo root)
 * Exit 0 = verified (or no Raw HID interface present — nothing to verify);
 * non-zero = verification failed.
 */

import assert from 'node:assert/strict';
import { ConsoleCore } from '@vibebridge/core';
import { hidIntegration } from '../app/src/main/hid';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('=== unknown-rawhid-readonly-test (generic, round-15) ===');
  console.log(`node version: ${process.version}`);

  const hid = hidIntegration();
  const candidates = await hid.enumerateInterfaces[0](null as never);
  const rawHid = candidates.filter((c) => c.usagePage === 0xff60 && c.usageId === 0x61);
  console.log(`\n[1] HID interfaces enumerated: ${candidates.length}`);
  for (const c of candidates) {
    console.log(`    ${c.kind} vid=0x${(c.vendorId ?? 0).toString(16)} pid=0x${(c.productId ?? 0).toString(16)} up=0x${(c.usagePage ?? 0).toString(16)} u=0x${(c.usageId ?? 0).toString(16)} path=${c.path ?? '(none)'}`);
  }
  console.log(`    Raw HID interfaces (0xFF60/0x61): ${rawHid.length}`);

  if (rawHid.length === 0) {
    console.log('\nSKIPPED: no Raw HID interface connected — nothing to verify (exit 0).');
    return;
  }

  // Fresh core with NO user-assigned profiles: every Raw HID interface must
  // be treated as unknown (transport-available, capabilities unknown).
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-ro-test-')), 'config.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    agentSources: [], activeAgentSource: 'none', executor: 'off', writePolicy: 'read-only', devices: [],
  }));

  const core = new ConsoleCore({
    settingsPath,
    enumerateInterfaces: hid.enumerateInterfaces,
    openTransport: hid.openTransport,
  });
  await core.start();
  await core.refreshDevices();

  const devices = core.listDevices().filter((d) => d.iface.usagePage === 0xff60 && d.iface.usageId === 0x61);
  console.log(`\n[2] registered Raw HID devices: ${devices.length}`);
  for (const d of devices) {
    console.log(`    ${d.label} status=${d.status} capsKnown=${d.capabilitiesKnown} profile=${d.profileId ?? '(none)'}`);
    // never ready, never unsupported, never protocol-identified without a profile
    assert.notEqual(d.status, 'ready', `${d.id} must not be ready without a verified profile`);
    assert.notEqual(d.status, 'unsupported', `${d.id} must not be unsupported (unknown != unsupported)`);
    assert.equal(d.capabilitiesKnown, false, `${d.id} capabilities must be unknown`);
    assert.ok(!d.profileId, `${d.id} must not have a control profile`);
    assert.equal(d.writeCount, 0, `${d.id} write count must be 0`);
  }

  // [3] push AI events through the mapping pipeline — nothing may be written
  await core.dispatchAiEvent({ type: 'thinking', source: 'test', ts: Date.now(), confidence: 1, simulated: true });
  await core.dispatchAiEvent({ type: 'waiting-for-approval', source: 'test', ts: Date.now(), confidence: 1, simulated: true });
  await delay(300);

  // [4] an explicit op attempt must be blocked by the gate and write nothing
  for (const d of devices) {
    const res = await core.triggerOp({
      kind: 'set-indicator',
      deviceId: d.id,
      label: 'test indicator (must be blocked)',
      payload: { color: { r: 255, g: 0, b: 0 } },
    });
    assert.equal(res.ok, false, `${d.id}: op must be blocked`);
  }
  await delay(200);

  const writes = core.writeCount();
  console.log(`\n[3] writes to unknown Raw HID devices: ${writes}`);
  assert.equal(writes, 0, 'ZERO writes to unknown Raw HID interfaces');
  console.log('\n=== VERIFIED: unknown Raw HID interfaces remain read-only with zero writes ===');

  await core.stop();
}

main().catch((err) => {
  console.error('\nVERIFICATION FAILED:', (err as Error).message);
  process.exit(1);
});
