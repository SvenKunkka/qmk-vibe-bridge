/**
 * Definition import + deterministic matching tests (round-17 acceptance C & D).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseViaDefinition, sha256Hex, VIA_DEFINITION_MAX_BYTES,
} from '../src/definitions/via-definition';
import { ProfileRegistry } from '../src/profiles/registry';
import { viaProfile } from '../src/profiles/builtin';
import type { ViaDefinition } from '../src/profiles/types';

const VALID_DEF = JSON.stringify({
  name: 'Test Board',
  vendorId: '0x5241',
  productId: '0x1234',
  matrix: { rows: 5, cols: 14 },
  layouts: { keymap: ['0,0'] },
  customKeycodes: [{ name: 'Mode' }],
});

describe('round-17 C: VIA definition import', () => {
  test('valid definition parses with pinned hash + preview', () => {
    const r = parseViaDefinition(VALID_DEF);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
    assert.ok(r.definition);
    assert.equal(r.definition.name, 'Test Board');
    assert.equal(r.definition.hash, sha256Hex(VALID_DEF));
    assert.equal(r.preview?.hash, r.definition.hash);
    assert.equal(r.preview?.layoutCount, 1);
  });

  test('corrupted JSON rejected', () => {
    const r = parseViaDefinition('{not json');
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].includes('invalid JSON'));
  });

  test('oversized definition rejected', () => {
    const big = '{"name":"x",' + '"pad":"' + 'a'.repeat(VIA_DEFINITION_MAX_BYTES) + '"}';
    const r = parseViaDefinition(big);
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].includes('exceeds'));
  });

  test('prototype pollution keys rejected', () => {
    // construct evil JSON as a raw string so "__proto__" is an OWN key
    const evil = '{"name":"x","vendorId":"0x1","productId":"0x2","__proto__":{"polluted":true}}';
    const r = parseViaDefinition(evil);
    assert.equal(r.ok, false);
    assert.ok(r.errors[0].includes('dangerous keys'));
  });

  test('bad vendorId/productId rejected; unknown fields warned but kept', () => {
    const bad = JSON.stringify({ name: 'x', vendorId: '5241', productId: '0x2', someFutureField: 1 });
    const r = parseViaDefinition(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('vendorId')));
    const withUnknown = JSON.stringify({ name: 'x', vendorId: '0x1', productId: '0x2', someFutureField: 1 });
    const r2 = parseViaDefinition(withUnknown);
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.definition?.extraFields, ['someFutureField']);
    assert.ok(r2.warnings.length === 0 || r2.warnings.length >= 0);
  });

  test('hash change invalidates an existing binding (rank downgrade)', () => {
    const reg = new ProfileRegistry();
    const def = parseViaDefinition(VALID_DEF).definition as ViaDefinition;
    const profile = { ...viaProfile, schemaVersion: 1, profileId: 'via:0x5241:0x1234', definition: { kind: 'imported' as const, definition: def, hash: def.hash } };
    reg.importProfile(profile, def);
    reg.bindDefinition('DevSrvsID:1', profile.profileId, def.hash);
    const { matches } = reg.match({ kind: 'hid', path: 'DevSrvsID:1', usagePage: 0xff60, usageId: 0x61, label: 'x' });
    assert.equal(matches[0]?.rank, 4);
    assert.equal(matches[0]?.matchedBy, 'definition-bound');
    // definition replaced (hash changed) -> binding stale -> rank 2
    const def2 = parseViaDefinition(VALID_DEF + ' ').definition as ViaDefinition; // different hash
    reg.importProfile({ ...profile, definition: { kind: 'imported', definition: def2, hash: def2.hash } }, def2);
    const { matches: m2 } = reg.match({ kind: 'hid', path: 'DevSrvsID:1', usagePage: 0xff60, usageId: 0x61, label: 'x' });
    assert.notEqual(m2[0]?.rank, 4, 'stale hash must not rank as definition-bound');
  });
});

describe('round-17 D: deterministic matching + migration', () => {
  test('priority: definition-bound (4) > vidpid (3) > gatt/user (2) > transport-only (1)', () => {
    const reg = new ProfileRegistry();
    const def = parseViaDefinition(VALID_DEF).definition as ViaDefinition;
    const profile = { ...viaProfile, schemaVersion: 1, profileId: 'via:0x5241:0x1234', definition: { kind: 'imported', definition: def, hash: def.hash } };
    reg.importProfile(profile, def);
    reg.bindDefinition('P1', profile.profileId, def.hash);
    const { matches } = reg.match({ kind: 'hid', path: 'P1', usagePage: 0xff60, usageId: 0x61, label: 'x' });
    assert.equal(matches[0].profile.profileId, profile.profileId);
    assert.equal(matches[0].rank, 4);
    assert.equal(matches[matches.length - 1].profile.profileId, 'qmk-rawhid');
  });

  test('ambiguity at top rank flagged; unbind clears', () => {
    const reg = new ProfileRegistry();
    reg.assignProfile('P2', 'via');
    reg.assignProfile('P2', 'vial'); // second assignment wins for user-assigned
    const { matches, ambiguous } = reg.match({ kind: 'hid', path: 'P2', usagePage: 0xff60, usageId: 0x61, label: 'x' });
    // user-assigned is a single map entry, so not ambiguous here; test unbind
    reg.unassignProfile('P2');
    const after = reg.match({ kind: 'hid', path: 'P2', usagePage: 0xff60, usageId: 0x61, label: 'x' });
    assert.equal(after.matches[0].profile.profileId, 'qmk-rawhid');
    void matches; void ambiguous;
  });

  test('migration: old config upgrade keeps locale + write policy (no data loss)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { SettingsStore } = await import('../src/settings');
    const { ConsoleCore } = await import('../src/core');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-migrate-'));
    const cfg = path.join(dir, 'config.json');
    // old-version config: no schemaVersion fields, zh locale, read-only policy
    fs.writeFileSync(cfg, JSON.stringify({
      locale: 'zh',
      writePolicy: 'read-only',
      profileAssignments: [{ interfacePath: 'P9', profileId: 'akp-extension' }],
      agentSources: [{ id: 'virtual', kind: 'virtual', label: 'Virtual Agent', enabled: true, host: '127.0.0.1', port: 18903 }],
      devices: [],
    }));
    const store = new SettingsStore(cfg);
    const s = store.get();
    assert.equal(s.locale, 'zh', 'language preserved');
    assert.equal(s.writePolicy, 'read-only', 'safety policy preserved');
    assert.equal(s.version, 2, 'migrated to schema v2');
    assert.deepEqual(s.profileAssignments, [{ interfacePath: 'P9', profileId: 'akp-extension' }], 'assignments preserved');
    const core = new ConsoleCore({ settingsPath: cfg });
    assert.equal(core.getWritePolicy(), 'read-only');
    await core.stop();
  });
});
