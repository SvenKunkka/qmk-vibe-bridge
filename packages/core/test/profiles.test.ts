/**
 * Profiles registry + mapping + i18n unit tests (round-15 items 1/4/15/16/17).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileRegistry } from '../src/profiles/registry';
import { isQmkRawHidInterface, QMK_RAW_HID_PAGE, QMK_RAW_HID_USAGE } from '../src/profiles/builtin';
import { MappingEngine, STATE_VISUALS } from '../src/mapping/engine';
import { UNKNOWN_CAPABILITIES } from '../src/capabilities/model';
import { normalizeLocale, translate } from '../src/i18n';

describe('Profile registry (item 1/4)', () => {
  test('bare Raw HID interface matches ONLY the transport profile', () => {
    const reg = new ProfileRegistry();
    const { matches } = reg.match({ kind: 'hid', path: 'P1', usagePage: 0xff60, usageId: 0x61, label: 'x' });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].profile.profileId, 'qmk-rawhid');
    assert.equal(matches[0].matchedBy, 'usage-page');
    assert.equal(matches[0].rank, 1);
  });

  test('raw HID interface with user-assigned VIA profile matches both', () => {
    const reg = new ProfileRegistry();
    reg.assignProfile('P1', 'via');
    const { matches } = reg.match({ kind: 'hid', path: 'P1', usagePage: 0xff60, usageId: 0x61, label: 'x' });
    assert.ok(matches.some((m) => m.profile.profileId === 'via' && m.matchedBy === 'user-assigned'));
    assert.ok(matches.some((m) => m.profile.profileId === 'qmk-rawhid'));
    // deterministic priority: user-assigned (rank 2) sorts above transport-only (rank 1)
    assert.equal(matches[0].profile.profileId, 'via');
  });

  test('BLE device with Studio GATT service matches zmk-studio', () => {
    const reg = new ProfileRegistry();
    const { matches } = reg.match({ kind: 'ble', path: 'AA:BB', serviceUuids: ['00000000-0196-6107-c967-c5cfb1c2482a'], label: 'b' });
    assert.ok(matches.some((m) => m.profile.profileId === 'zmk-studio' && m.matchedBy === 'gatt-service'));
  });

  test('isQmkRawHidInterface checks BOTH usage page and usage id', () => {
    assert.equal(isQmkRawHidInterface(QMK_RAW_HID_PAGE, QMK_RAW_HID_USAGE), true);
    assert.equal(isQmkRawHidInterface(QMK_RAW_HID_PAGE, 0x62), false);
    assert.equal(isQmkRawHidInterface(0xffc1, QMK_RAW_HID_USAGE), false);
  });

  test('every profile declares all 12 capabilities', () => {
    const reg = new ProfileRegistry();
    for (const p of reg.all()) {
      assert.equal(Object.keys(p.capabilities).length, 12, `${p.profileId} must declare all 12 capabilities`);
    }
  });

  test('protocols without a capability say unsupported, never fake supported', () => {
    const reg = new ProfileRegistry();
    const studio = reg.get('zmk-studio')!;
    assert.equal(studio.capabilities['set-rgb'], 'unsupported');
    assert.equal(studio.capabilities['display-text'], 'unsupported');
    const qmk = reg.get('qmk-rawhid')!;
    assert.equal(qmk.capabilities['set-indicator'], 'unknown');
  });
});

describe('Mapping engine (item 17)', () => {
  test('AI state maps to indicator + display + rgb ops', () => {
    const m = new MappingEngine();
    const ops = m.desiredOps('thinking', 'd1', 'reasoning…');
    assert.ok(ops.some((o) => o.kind === 'set-indicator'));
    assert.ok(ops.some((o) => o.kind === 'display-text' && (o.payload as { text: string }).text.startsWith('reasoning')));
    assert.ok(ops.some((o) => o.kind === 'set-rgb'));
  });

  test('feasibility respects declared capability states', () => {
    const m = new MappingEngine();
    const mapped = m.map(
      { type: 'thinking', source: 's', ts: 1, confidence: 1, simulated: true },
      { deviceId: 'd1', caps: { ...UNKNOWN_CAPABILITIES, 'set-indicator': 'supported' } },
    );
    const ind = mapped.find((x) => x.op.kind === 'set-indicator');
    assert.ok(ind?.feasible);
    const rgb = mapped.find((x) => x.op.kind === 'set-rgb');
    assert.equal(rgb?.feasible, false);
  });

  test('STATE_VISUALS covers every AI event type', () => {
    for (const t of ['idle', 'thinking', 'tool-running', 'waiting-for-approval', 'waiting-for-user', 'done', 'error', 'disconnected']) {
      assert.ok(STATE_VISUALS[t], `missing visual for ${t}`);
    }
  });
});

describe('i18n (items 15 & 16)', () => {
  test('missing/unknown locale normalizes to English (default)', () => {
    assert.equal(normalizeLocale(undefined), 'en');
    assert.equal(normalizeLocale('fr'), 'en');
    assert.equal(normalizeLocale(''), 'en');
  });

  test('Chinese variants normalize to zh', () => {
    assert.equal(normalizeLocale('zh'), 'zh');
    assert.equal(normalizeLocale('zh-CN'), 'zh');
    assert.equal(normalizeLocale('zh_CN'), 'zh');
  });

  test('English dictionary is complete and does not mention AKP handshake', () => {
    const en = translate('en', 'device.ready');
    assert.equal(en, 'Ready');
    // forbidden strings must not exist in the UI dictionary
    assert.ok(!translate('en', 'device.handshake').includes('AKP'));
    assert.ok(!translate('en', 'device.incompatible').includes('AKP'));
    assert.ok(!translate('en', 'device.incompatible').includes('Incompatible'));
  });

  test('read-only banner string matches the round-15 wording', () => {
    assert.equal(
      translate('en', 'device.readonlyBanner'),
      'QMK Raw HID transport found. No verified control profile is selected. The device will remain read-only.',
    );
  });

  test('locales() lists English first (default)', () => {
    const [first] = require('../src/i18n').locales() as string[];
    assert.equal(first, 'en');
  });
});

describe('round-16 P1-3: capability declarations match adapter implementations', () => {
  test('every declared supported/read-only/requires-* capability has an adapter handler', async () => {
    const { BUILTIN_PROFILES } = await import('../src/profiles/builtin');
    const { createAdapter } = await import('../src/adapters/factory');
    const { QmkRawHidAdapter } = await import('../src/adapters/qmk-rawhid');
    const { ViaAdapter } = await import('../src/adapters/via');
    const { VialAdapter } = await import('../src/adapters/vial');
    const { ZmkStudioAdapter } = await import('../src/adapters/zmk-studio/index');
    const { AkpExtensionAdapter } = await import('../src/adapters/akp-extension/index');
    const { SimulatorAdapter } = await import('../src/adapters/simulator');
    const implemented = new Map<string, string[]>([
      ['qmk-rawhid', QmkRawHidAdapter.implementedCapabilities],
      ['via', ViaAdapter.implementedCapabilities],
      ['vial', VialAdapter.implementedCapabilities],
      ['zmk-studio', ZmkStudioAdapter.implementedCapabilities],
      ['akp-extension', AkpExtensionAdapter.implementedCapabilities],
      ['simulator', SimulatorAdapter.implementedCapabilities],
    ]);
    const claimable = new Set(['supported', 'read-only', 'requires-user-profile', 'requires-optional-extension']);
    for (const profile of BUILTIN_PROFILES) {
      const impl = implemented.get(profile.profileId) ?? [];
      for (const [cap, state] of Object.entries(profile.capabilities)) {
        if (claimable.has(state)) {
          assert.ok(
            impl.includes(cap as never),
            `${profile.profileId}: capability "${cap}" declared ${state} but the adapter has no handler (implemented: ${impl.join(',') || 'none'})`,
          );
        }
      }
    }
    // spot check: VIA lighting is now requires-user-profile AND implemented
    // (round-17 P4); haptics/matrix-reads stay unsupported
    const reg = new ProfileRegistry();
    const via = reg.get('via')!;
    assert.equal(via.capabilities['set-rgb-matrix'], 'requires-user-profile');
    assert.equal(via.capabilities['set-backlight'], 'requires-user-profile');
    assert.equal(via.capabilities['haptic'], 'unsupported');
    assert.equal(via.capabilities['read-key-event'], 'unsupported');
    assert.equal(via.capabilities['runtime-keymap'], 'supported');
    assert.ok(ViaAdapter.implementedCapabilities.includes('set-rgb'));
    assert.ok(ViaAdapter.implementedCapabilities.includes('set-rgb-matrix'));
    assert.ok(ViaAdapter.implementedCapabilities.includes('set-backlight'));
    const vial = reg.get('vial')!;
    assert.equal(vial.capabilities['runtime-keymap'], 'unsupported');
    void createAdapter;
  });

  test('every requires-* capability has an adapter handler (round-17 rule)', () => {
    const { ViaAdapter: V } = require('../src/adapters/via') as { ViaAdapter: typeof import('../src/adapters/via').ViaAdapter };
    const implemented = new Set<string>(V.implementedCapabilities);
    const reg = new ProfileRegistry();
    for (const p of reg.all()) {
      for (const [cap, state] of Object.entries(p.capabilities)) {
        if (state === 'requires-user-profile' || state === 'requires-optional-extension') {
          assert.ok(implemented.has(cap), `${p.profileId}.${cap} declares ${state} but has no adapter handler`);
        }
      }
    }
  });
});
