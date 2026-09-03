/**
 * Devices view DOM test (round-15). Loads the REAL built renderer bundle
 * against a happy-dom window with a fake window.api: seven distinct statuses,
 * capability tables, the read-only banner and the English/Chinese toggle.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

interface FakeDevice {
  id: string;
  label: string;
  status: string;
  capabilities: Record<string, string> | null;
  capabilitiesKnown: boolean;
  writeCount: number;
  iface: { path?: string; label: string; kind: string };
  adapterId?: string;
  profileId?: string | null;
}

function makeApi(devices: FakeDevice[], locale = 'en') {
  return {
    onEvent: (cb: (e: unknown) => void) => {
      (globalThis as unknown as { __cb?: (e: unknown) => void }).__cb = cb;
      return () => {};
    },
    listDevices: () => Promise.resolve(devices),
    listProfiles: () => Promise.resolve([]),
    recentAudit: () => Promise.resolve([]),
    writeCount: () => Promise.resolve(0),
    getWritePolicy: () => Promise.resolve('read-only'),
    getSettings: () => Promise.resolve({ locale, agentSources: [] }),
    simStatus: () => Promise.resolve({ running: false }),
    setLocale: () => Promise.resolve(),
    startSimulator: () => Promise.resolve({ running: true }),
    stopSimulator: () => Promise.resolve({ running: false }),
    connectDevice: () => Promise.resolve(),
    disconnectDevice: () => Promise.resolve(),
    assignProfile: () => Promise.resolve(),
    setWritePolicy: () => Promise.resolve(),
    triggerAction: () => Promise.resolve(),
    updateSettings: () => Promise.resolve(),
    confirmOp: () => Promise.resolve({ ok: true }),
    pendingConfirmations: () => Promise.resolve([]),
    triggerOp: () => Promise.resolve({ ok: true }),
    setShowAllInterfaces: () => Promise.resolve(),
    refreshDevices: () => Promise.resolve([]),
    setWritesDisabled: () => Promise.resolve(),
    getWritesDisabled: () => Promise.resolve(true),
    apiStatus: () => Promise.resolve(null),
    apiToken: () => Promise.resolve(''),
    apiStart: () => Promise.resolve({}),
    apiTestEvent: () => Promise.resolve({}),
    apiRevokeToken: () => Promise.resolve(),
    apiSetConflictPolicy: () => Promise.resolve(),
    importDefinition: () => Promise.resolve({ ok: false, errors: ['no-op'], warnings: [] }),
    bindDefinition: () => Promise.resolve({ ok: false }),
    unbindProfile: () => Promise.resolve(),
    exportDiagnostics: () => Promise.resolve({}),
  };
}

async function renderWith(devices: FakeDevice[], locale = 'en'): Promise<Window> {
  const win = new Window({ url: 'http://localhost/' });
  const saved: Array<[string, unknown]> = [];
  for (const k of ['window', 'document', 'navigator', 'location']) {
    saved.push([k, (globalThis as Record<string, unknown>)[k]]);
  }
  (globalThis as unknown as Record<string, unknown>).window = win;
  (globalThis as unknown as Record<string, unknown>).document = win.document;
  (globalThis as unknown as Record<string, unknown>).navigator = win.navigator;
  (globalThis as unknown as Record<string, unknown>).location = win.location;
  win.document.body.innerHTML = rendererHtml;
  (win as unknown as Record<string, unknown>).api = makeApi(devices, locale);
  const bundlePath = require.resolve('../dist/renderer/app.js');
  delete require.cache[bundlePath];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(bundlePath);
  await new Promise((r) => setTimeout(r, 150));
  for (const [k, v] of saved) {
    (globalThis as Record<string, unknown>)[k] = v;
  }
  return win;
}

describe('devices view DOM (round-15)', () => {
  beforeEach(() => {
    (globalThis as unknown as { __cb?: unknown }).__cb = undefined;
  });

  test('English default: nav labels are English, no Chinese leftovers', async () => {
    const win = await renderWith([], 'en');
    const nav = win.document.querySelector('[data-view="devices"]')?.textContent ?? '';
    assert.equal(nav, 'Devices');
    assert.ok(!win.document.body.textContent.includes('设备'));
  });

  test('read-only banner shown for transport-available device with unknown capabilities', async () => {
    const dev: FakeDevice = {
      id: 'd1', label: 'Raw HID keyboard', status: 'transport-available', capabilities: null,
      capabilitiesKnown: false, writeCount: 0, iface: { path: 'DevSrvsID:1', label: 'k', kind: 'hid' },
    };
    const win = await renderWith([dev], 'en');
    const banner = win.document.querySelector('.banner.readonly')?.textContent ?? '';
    assert.ok(
      banner.includes('QMK Raw HID transport found. No verified control profile is selected. The device will remain read-only.'),
      `banner was: ${banner}`,
    );
  });

  test('ready device shows capability table with honest states', async () => {
    const dev: FakeDevice = {
      id: 'd1', label: 'Studio KB', status: 'ready', capabilitiesKnown: true,
      capabilities: {
        'read-key-event': 'unsupported', 'runtime-keymap': 'supported', 'set-rgb': 'unsupported',
        'set-indicator': 'unknown', 'set-backlight': 'unsupported', 'display-text': 'unsupported',
        'display-icon': 'unsupported', 'haptic': 'unsupported', 'read-encoder-event': 'unsupported',
        'set-rgb-matrix': 'unsupported', 'approval-input': 'unsupported', 'profile-switch': 'unsupported',
      },
      writeCount: 0, iface: { path: 'serial:///dev/ttyACM0', label: 'k', kind: 'serial' }, adapterId: 'zmk-studio', profileId: 'zmk-studio',
    };
    const win = await renderWith([dev], 'en');
    const caps = win.document.querySelector('.caps-table')?.textContent ?? '';
    assert.ok(caps.includes('runtime-keymap'), `caps: ${caps}`);
    assert.ok(caps.includes('supported'));
    assert.ok(caps.includes('unsupported'));
    const badge = win.document.querySelector('.badge')?.textContent ?? '';
    assert.equal(badge, 'Ready');
  });

  test('status ladder renders distinct labels', async () => {
    const statuses = ['hardware-detected', 'transport-available', 'protocol-identified', 'capabilities-known', 'limited', 'ready', 'unsupported', 'permission-denied', 'disconnected', 'error'];
    const devices: FakeDevice[] = statuses.map((s, i) => ({
      id: `d${i}`, label: `dev-${s}`, status: s, capabilities: null, capabilitiesKnown: false,
      writeCount: 0, iface: { path: `P${i}`, label: 'k', kind: 'hid' },
    }));
    const win = await renderWith(devices, 'en');
    const texts = [...win.document.querySelectorAll('.badge')].map((b) => b.textContent ?? '');
    for (const expect of ['Hardware detected', 'Transport found', 'Protocol identified', 'Capabilities known', 'Limited support', 'Ready', 'Unsupported', 'Permission denied', 'Disconnected', 'Error']) {
      assert.ok(texts.includes(expect), `missing "${expect}" in ${texts.join(',')}`);
    }
  });

  test('write count is displayed per device', async () => {
    const dev: FakeDevice = {
      id: 'd1', label: 'k', status: 'ready', capabilities: null, capabilitiesKnown: false,
      writeCount: 7, iface: { path: 'P1', label: 'k', kind: 'hid' },
    };
    const win = await renderWith([dev], 'en');
    assert.equal(win.document.querySelector('.write-count')?.textContent ?? '', '7');
  });
});
