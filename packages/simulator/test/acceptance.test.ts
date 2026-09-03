/**
 * Acceptance tests (round-15), items 1–18. These exercise the layered
 * pipeline end-to-end: Simulator (TCP virtual keyboard in every mode) +
 * ConsoleCore + Mapping + Capability Gate + adapters + audit.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConsoleCore } from '@vibebridge/core';
import { VirtualKeyboardServer, VirtualAgentServer, type VirtualKeyboardMode } from '../src/index';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ScenarioResult {
  core: ConsoleCore;
  kb: VirtualKeyboardServer;
  agent: VirtualAgentServer;
  settingsPath: string;
  kbPort: number;
}

/** Fresh core wired to a virtual keyboard of the given mode. */
async function scenario(
  mode: VirtualKeyboardMode,
  opts: { profileId?: string; writePolicy?: 'read-only' | 'ask' | 'allow' } = {},
): Promise<ScenarioResult> {
  const kb = new VirtualKeyboardServer({ port: 0, mode });
  const agent = new VirtualAgentServer({ port: 0, auto: false, thinkingMs: 60, toolMs: 40, continueMs: 40 });
  const kbPort = await kb.start();
  const agentPort = await agent.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-acc-'));
  const settingsPath = path.join(dir, 'config.json');
  fs.writeFileSync(settingsPath, JSON.stringify({
    agentSources: [
      { id: 'virtual', kind: 'virtual', label: 'Virtual Agent', enabled: true, host: '127.0.0.1', port: agentPort },
      { id: 'dsh', kind: 'dsh', label: 'DSH', enabled: false },
    ],
    activeAgentSource: 'virtual',
    executor: 'off',
    writePolicy: opts.writePolicy ?? 'read-only',
    devices: [],
  }));
  const core = new ConsoleCore({ settingsPath });
  await core.start();
  // tests explicitly exercise writes where needed — turn the master kill
  // switch off (a user would do this in Settings)
  if (opts.writePolicy !== 'read-only') core.setWritesDisabled(false);
  await core.addSimulatorDevice({ id: 'vk', label: 'Virtual KB', kind: 'virtual', host: '127.0.0.1', port: kbPort, mtu: 32, enabled: true });
  if (opts.profileId) {
    core.assignProfile(`tcp://127.0.0.1:${kbPort}`, opts.profileId);
    await core.connectDevice('vk', opts.profileId);
  }
  await sleep(300);
  return { core, kb, agent, settingsPath, kbPort };
}

async function teardown(r: ScenarioResult): Promise<void> {
  await r.core.stop();
  await r.kb.stop();
  await r.agent.stop();
}

describe('acceptance (round-15)', () => {
  test('A1: QMK Raw HID-looking interface is recognized as transport-available', async () => {
    const r = await scenario('unknown-rawhid');
    const dev = r.core.devices.get('vk');
    assert.ok(dev, 'device registered');
    assert.equal(dev.status, 'transport-available');
    assert.equal(dev.capabilitiesKnown, false);
    assert.ok(!dev.profileId, 'no control profile matched');
    await teardown(r);
  });

  test('A2: no AKP HELLO -> never "firmware incompatible"', async () => {
    const r = await scenario('unknown-rawhid');
    const dev = r.core.devices.get('vk');
    assert.notEqual(dev?.status, 'unsupported');
    assert.ok(!dev?.error?.includes('incompatible'));
    await teardown(r);
  });

  test('A3: unknown Raw HID write count is strictly 0', async () => {
    const r = await scenario('unknown-rawhid');
    assert.equal(r.core.writeCount(), 0);
    // trigger the mapping path directly
    await r.core.dispatchAiEvent({ type: 'thinking', source: 'virtual', ts: Date.now(), confidence: 1, simulated: true });
    await sleep(200);
    assert.equal(r.core.writeCount(), 0, 'zero writes to unknown Raw HID');
    await teardown(r);
  });

  test('A4: writes only after matching a verified profile', async () => {
    const r = await scenario('akp', { profileId: 'akp-extension', writePolicy: 'allow' });
    const dev = r.core.devices.get('vk');
    assert.equal(dev?.adapterId, 'akp-extension');
    assert.equal(dev?.status, 'ready');
    const op = { kind: 'set-indicator' as const, deviceId: 'vk', label: 'indicator', payload: { color: { r: 255, g: 0, b: 0 } } };
    // user policy still blocks until explicitly enabled for this device
    const blocked = await r.core.triggerOp(op);
    assert.equal(blocked.ok, false, 'user policy blocks writes until enabled');
    assert.equal(r.core.writeCount(), 0);
    // user enables writes -> gated write allowed (profile matched + gate passed)
    r.core.setDeviceWriteEnabled('vk', true);
    const allowed = await r.core.triggerOp(op);
    assert.equal(allowed.ok, true);
    assert.equal(r.core.writeCount(), 1);
    await teardown(r);
  });

  test('A5: Capability Gate rejects undeclared capabilities', async () => {
    const r = await scenario('akp', { profileId: 'akp-extension', writePolicy: 'allow' });
    r.core.setDeviceWriteEnabled('vk', true);
    // haptic is declared unsupported by AKP — the gate must refuse
    const op = { kind: 'haptic' as const, deviceId: 'vk', label: 'haptic', payload: { pattern: 'buzz' } };
    const res = await r.core.triggerOp(op);
    assert.equal(res.ok, false);
    assert.ok(res.error?.includes('unsupported'));
    await teardown(r);
  });

  test('A6: AKP as optional adapter handshakes independently', async () => {
    const r = await scenario('akp', { profileId: 'akp-extension' });
    const dev = r.core.devices.get('vk');
    assert.equal(dev?.status, 'ready');
    assert.equal(dev?.profileId, 'akp-extension');
    await teardown(r);
  });

  test('A7: AKP handshake result does not affect other adapters', async () => {
    // an unknown Raw HID device (no AKP) must not pollute a VIA device
    const kbA = new VirtualKeyboardServer({ port: 0, mode: 'unknown-rawhid' });
    const kbB = new VirtualKeyboardServer({ port: 0, mode: 'via' });
    const agent = new VirtualAgentServer({ port: 0, auto: false });
    const pa = await kbA.start();
    const pb = await kbB.start();
    const pa2 = await agent.start();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-acc7-'));
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      agentSources: [{ id: 'virtual', kind: 'virtual', label: 'v', enabled: true, host: '127.0.0.1', port: pa2 }],
      activeAgentSource: 'virtual', executor: 'off', writePolicy: 'read-only', devices: [],
    }));
    const core = new ConsoleCore({ settingsPath });
    await core.start();
    await core.addSimulatorDevice({ id: 'a', label: 'A', kind: 'virtual', host: '127.0.0.1', port: pa, mtu: 32, enabled: true });
    await core.addSimulatorDevice({ id: 'b', label: 'B', kind: 'virtual', host: '127.0.0.1', port: pb, mtu: 32, enabled: true });
    core.assignProfile(`tcp://127.0.0.1:${pb}`, 'via');
    await core.connectDevice('b', 'via');
    await sleep(300);
    const devB = core.devices.get('b');
    assert.equal(devB?.adapterId, 'via', 'VIA device identifies regardless of the unknown device');
    assert.equal(devB?.status, 'ready');
    const devA = core.devices.get('a');
    assert.equal(devA?.status, 'transport-available', 'unknown device stays transport-available');
    assert.equal(core.writeCount(), 0);
    await core.stop();
    await kbA.stop(); await kbB.stop(); await agent.stop();
  });

  test('A8/A9: ZMK Studio framing + protobuf round-trip', async () => {
    const r = await scenario('zmk-studio', { profileId: 'zmk-studio' });
    const dev = r.core.devices.get('vk');
    assert.equal(dev?.adapterId, 'zmk-studio');
    assert.equal(dev?.status, 'ready');
    await teardown(r);
  });

  test('A12: BLE not hardware-verified -> Partial (documented marker)', async () => {
    // BleGattTransport is DESIGN/PARTIAL: no real BLE round trip exists.
    // We assert the transport exists and that the docs mark it partial.
    const { BleGattTransport } = await import('@vibebridge/core');
    const driver = {
      scan: async () => [],
      connect: async () => ({ write: async () => {}, close: async () => {} }),
    };
    const t = new BleGattTransport({ id: 'ble', label: 'ble', address: 'AA:BB', driver });
    assert.equal(t.exactPath.startsWith('ble://'), true);
    assert.equal(t.kind, 'ble');
    const docs = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'HARDWARE_VALIDATION.md'), 'utf8');
    assert.ok(/PARTIAL/i.test(docs) || /Partial/i.test(docs), 'docs must mark BLE partial');
  });

  test('A15/A16: English default + Chinese switch persists', async () => {
    const r = await scenario('akp');
    assert.equal(r.core.settings.get().locale, 'en', 'fresh config defaults to English');
    r.core.setLocale('zh');
    assert.equal(r.core.settings.get().locale, 'zh');
    const again = new ConsoleCore({ settingsPath: r.settingsPath });
    assert.equal(again.settings.get().locale, 'zh', 'language persists across restart');
    await again.stop();
    await teardown(r);
  });

  test('A17: AI Event -> Capability Mapping simulated e2e', async () => {
    const r = await scenario('simulator', { profileId: 'simulator', writePolicy: 'allow' });
    r.core.setDeviceWriteEnabled('vk', true);
    const dev = r.core.devices.get('vk');
    assert.equal(dev?.adapterId, 'simulator');
    // emit an AI event; feasible ops flow to the simulator keyboard
    const ev = { type: 'thinking' as const, source: 'virtual', agentId: 'sim', ts: Date.now(), confidence: 1, simulated: true };
    await r.core.dispatchAiEvent(ev);
    await sleep(300);
    assert.ok(r.core.writeCount() >= 1, 'mapped ops reached the simulator keyboard');
    const ops = r.core.previewOps('vk');
    assert.ok(ops.some((m) => m.op.kind === 'set-indicator'));
    assert.ok(ops.every((m) => m.feasible));
    await teardown(r);
  });
});

describe('round-16 P1-1: ZMK Studio physical unlock (e2e via simulator)', () => {
  test('unlock is physical: zero writes; only lock_state_changed enables keymap', async () => {
    const r = await scenario('zmk-studio', { profileId: 'zmk-studio', writePolicy: 'allow' });
    r.core.setDeviceWriteEnabled('vk', true);
    const dev = r.core.devices.get('vk');
    assert.equal(dev?.adapterId, 'zmk-studio');
    const writesBefore = r.core.writeCount();

    // unlock request: must NOT write and must NOT fake success
    const unlock = await r.core.triggerOp({ kind: 'runtime-keymap', deviceId: 'vk', label: 'unlock', payload: { action: 'unlock' } });
    assert.equal(unlock.ok, false, 'unlock never reports success');
    assert.equal(r.core.writeCount(), writesBefore, 'unlock wrote zero bytes');

    // get-keymap while locked: blocked, zero writes
    const blocked = await r.core.triggerOp({ kind: 'runtime-keymap', deviceId: 'vk', label: 'get keymap', payload: { action: 'get-keymap' } });
    assert.equal(blocked.ok, false, 'keymap blocked while locked');
    assert.equal(r.core.writeCount(), writesBefore, 'no writes while locked');

    // physical unlock on the keyboard -> firmware notifies -> keymap works
    assert.equal(r.kb.simulatePhysicalUnlock(), true);
    await sleep(300);
    const ok = await r.core.triggerOp({ kind: 'runtime-keymap', deviceId: 'vk', label: 'get keymap', payload: { action: 'get-keymap' } });
    assert.equal(ok.ok, true, 'keymap succeeds only after physical unlock notification');
    await teardown(r);
  });
});

describe('round-17 P4: VIA lighting with bound definition (e2e)', () => {
  test('import definition -> bind -> probe -> set-rgb applied with readback', async () => {
    const kb = new VirtualKeyboardServer({ port: 0, mode: 'via', viaChannels: [1, 2, 3] });
    const agent = new VirtualAgentServer({ port: 0, auto: false });
    const kbPort = await kb.start();
    const agentPort = await agent.start();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-vialight-'));
    const settingsPath = path.join(dir, 'config.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      agentSources: [{ id: 'virtual', kind: 'virtual', label: 'Virtual Agent', enabled: true, host: '127.0.0.1', port: agentPort }],
      activeAgentSource: 'virtual', executor: 'off', writePolicy: 'allow', devices: [],
    }));
    const core = new ConsoleCore({ settingsPath });
    core.setWritesDisabled(false);
    await core.start();
    await core.addSimulatorDevice({ id: 'vk', label: 'VIA KB', kind: 'virtual', host: '127.0.0.1', port: kbPort, mtu: 32, enabled: true });
    // import a definition and bind it to the interface
    const defJson = JSON.stringify({ name: 'Test VIA Board', vendorId: '0x5241', productId: '0x1234', matrix: { rows: 5, cols: 14 }, layouts: { keymap: ['0,0'] } });
    const imp = core.importViaDefinition(defJson);
    assert.equal(imp.ok, true, JSON.stringify(imp.errors));
    const profileId = imp.profileId!;
    const ifacePath = `tcp://127.0.0.1:${kbPort}`;
    const bind = core.bindDefinition(ifacePath, profileId);
    assert.equal(bind.ok, true, bind.error);
    await core.connectDevice('vk', profileId);
    core.setDeviceWriteEnabled('vk', true);
    await sleep(400);
    const dev = core.devices.get('vk');
    assert.equal(dev?.adapterId, 'via');
    // lighting capabilities probed: all three channels present in the sim
    assert.equal(dev?.capabilities?.['set-rgb'], 'supported');
    assert.equal(dev?.capabilities?.['set-rgb-matrix'], 'supported');
    assert.equal(dev?.capabilities?.['set-backlight'], 'supported');
    // set-rgb with readback -> applied
    const res = await core.triggerOp({ kind: 'set-rgb', deviceId: 'vk', label: 'blue', payload: { mode: 'solid', color: { r: 0, g: 0, b: 255 } } });
    assert.equal(res.ok, true, res.error);
    assert.equal((res as { outcome?: string }).outcome, 'applied');
    await core.stop();
    await kb.stop();
    await agent.stop();
  });
});
