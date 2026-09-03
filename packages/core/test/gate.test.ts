/**
 * Capability Gate unit tests (round-15, acceptance item 5 + security policy).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WriteAudit } from '../src/capabilities/audit';
import { CapabilityGate, validatePayload } from '../src/capabilities/gate';
import { UNKNOWN_CAPABILITIES, type CapabilityMap, type CapabilityOp } from '../src/capabilities/model';

function ctx(overrides: Partial<Parameters<CapabilityGate['evaluate']>[1]> = {}) {
  return {
    deviceId: 'd1',
    interfaceLabel: 'iface',
    transport: 'usb-hid',
    adapter: 'akp-extension',
    profileId: 'akp-extension',
    profileVersion: '1.0',
    exactEndpoint: 'DevSrvsID:1234',
    capabilities: {
      ...UNKNOWN_CAPABILITIES,
      'set-indicator': 'supported',
      'haptic': 'unsupported',
      'display-text': 'supported',
    } as CapabilityMap,
    userWriteEnabled: true,
    ...overrides,
  };
}

function op(kind: CapabilityOp['kind'], payload: unknown): CapabilityOp {
  return { kind, deviceId: 'd1', label: kind, payload };
}

describe('CapabilityGate', () => {
  test('rejects when no exact endpoint (no blind open)', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'allow'); gate.setWritesDisabled(false);
    const d = gate.evaluate(op('set-indicator', { color: { r: 1, g: 2, b: 3 } }), ctx({ exactEndpoint: null }));
    assert.equal(d.allowed, false);
    assert.equal(d.blockedAt, 1);
  });

  test('rejects when no adapter identified', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'allow'); gate.setWritesDisabled(false);
    const d = gate.evaluate(op('set-indicator', { color: { r: 1, g: 2, b: 3 } }), ctx({ adapter: null }));
    assert.equal(d.allowed, false);
    assert.equal(d.blockedAt, 2);
  });

  test('rejects when no profile matched', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'allow'); gate.setWritesDisabled(false);
    const d = gate.evaluate(op('set-indicator', { color: { r: 1, g: 2, b: 3 } }), ctx({ profileId: null, profileVersion: null }));
    assert.equal(d.allowed, false);
    assert.equal(d.blockedAt, 3);
  });

  test('rejects undeclared (unsupported) capabilities', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'allow'); gate.setWritesDisabled(false);
    const d = gate.evaluate(op('haptic', { pattern: 'buzz' }), ctx());
    assert.equal(d.allowed, false);
    assert.equal(d.blockedAt, 4);
    assert.ok(d.reasons[0].includes('unsupported'));
  });

  test('rejects unknown capabilities — never guessed as supported', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'allow'); gate.setWritesDisabled(false);
    const c = ctx({ capabilities: { ...UNKNOWN_CAPABILITIES, 'set-rgb': 'unknown' } });
    const d = gate.evaluate(op('set-rgb', { mode: 'solid', color: { r: 1, g: 2, b: 3 } }), c);
    assert.equal(d.allowed, false);
    assert.equal(d.blockedAt, 4);
    assert.ok(d.reasons[0].includes('unknown'));
  });

  test('read-only policy blocks writes even when declared supported', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'read-only');
    const d = gate.evaluate(op('set-indicator', { color: { r: 1, g: 2, b: 3 } }), ctx());
    assert.equal(d.allowed, false);
    assert.equal(d.blockedAt, 5);
  });

  test('rejects invalid payloads', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'allow'); gate.setWritesDisabled(false);
    const d = gate.evaluate(op('set-indicator', { color: { r: 999, g: 0, b: 0 } }), ctx());
    assert.equal(d.allowed, false);
    assert.equal(d.blockedAt, 6);
  });

  test('rejects when user policy disallows writes', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'allow'); gate.setWritesDisabled(false);
    const d = gate.evaluate(op('set-indicator', { color: { r: 1, g: 2, b: 3 } }), ctx({ userWriteEnabled: false }));
    assert.equal(d.allowed, false);
    assert.equal(d.blockedAt, 7);
  });

  test('allows when every gate passes', () => {
    const gate = new CapabilityGate(new WriteAudit(), 'allow'); gate.setWritesDisabled(false);
    const d = gate.evaluate(op('set-indicator', { color: { r: 1, g: 2, b: 3 } }), ctx());
    assert.equal(d.allowed, true);
  });

  test('payload validator', () => {
    assert.equal(validatePayload(op('set-indicator', { color: { r: 0, g: 0, b: 0 } })), null);
    assert.ok(validatePayload(op('set-indicator', { color: { r: -1, g: 0, b: 0 } })));
    assert.ok(validatePayload(op('set-indicator', { color: 'red' })));
    assert.equal(validatePayload(op('display-text', { text: 'hi' })), null);
    assert.ok(validatePayload(op('display-text', { text: 'x'.repeat(300) })));
    assert.equal(validatePayload(op('set-rgb', { mode: 'solid' })), null);
  });

  test('audit records blocked attempts without writes', () => {
    const audit = new WriteAudit();
    const gate = new CapabilityGate(audit, 'read-only'); gate.setWritesDisabled(false);
    gate.evaluate(op('set-indicator', { color: { r: 1, g: 2, b: 3 } }), ctx());
    // audit recording is the caller's job; assert count API
    audit.record({ deviceId: 'd1', interfaceLabel: 'i', transport: 't', adapter: null, profileId: null, capability: 'set-indicator', opLabel: 'x', wrote: false, allowed: false, reasons: ['read-only'] });
    assert.equal(audit.countWrites(), 0);
    assert.equal(audit.countAttempts(), 1);
  });
});
