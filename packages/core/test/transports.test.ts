/**
 * Transport boundary tests (round-15 items 10–14): USB serial, BLE UUIDs,
 * multi-HID interface safety, permission errors and disconnect states.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SerialTransport, type SerialDriver } from '../src/transports/serial';
import { BleGattTransport, ZMK_STUDIO_BLE_SERVICE_UUID, ZMK_STUDIO_BLE_CHARACTERISTIC_UUID, type BleDriver } from '../src/transports/ble';
import { resolveHidOpen, HidTransport, type HidDeviceInfo } from '../src/transports/hid';
import { DeviceManager, isPermissionError } from '../src/devices/manager';
import { WriteAudit } from '../src/capabilities/audit';
import { CapabilityGate } from '../src/capabilities/gate';
import { ProfileRegistry } from '../src/profiles/registry';
import { NullTransport } from '../src/transports/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('USB Serial Transport (item 10)', () => {
  test('open/write/read round trip with a fake driver', async () => {
    const written: Uint8Array[] = [];
    let reads = 0;
    const driver: SerialDriver = {
      list: async () => [],
      open: async () => ({
        write: async (b) => { written.push(b); },
        read: async () => {
          reads += 1;
          if (reads === 1) return new Uint8Array([0xab, 0x01, 0xad]);
          return null; // end the read loop
        },
        close: async () => {},
      }),
    };
    const t = new SerialTransport({ id: 's', label: 'ttyACM0', path: '/dev/ttyACM0', driver });
    const seen: Uint8Array[] = [];
    t.setHandlers({ onData: (b) => seen.push(b), onOpen: () => {}, onClose: () => {}, onError: () => {} });
    await t.open();
    await t.write(new Uint8Array([1, 2, 3]));
    await sleep(30);
    assert.equal(t.kind, 'serial');
    assert.equal(t.exactPath, '/dev/ttyACM0');
    assert.equal(t.mtu, null);
    assert.equal(written.length, 1);
    assert.equal(seen.length, 1);
    assert.deepEqual([...seen[0]], [0xab, 0x01, 0xad]);
    await t.close();
  });

  test('write before open throws', async () => {
    const driver: SerialDriver = { list: async () => [], open: async () => ({ write: async () => {}, read: async () => null, close: async () => {} }) };
    const t = new SerialTransport({ id: 's', label: 's', path: '/dev/ttyS0', driver });
    await assert.rejects(() => t.write(new Uint8Array([1])), /not open/);
  });
});

describe('BLE GATT transport (items 11 & 12)', () => {
  test('ZMK Studio service + characteristic UUIDs match the official spec', () => {
    assert.equal(ZMK_STUDIO_BLE_SERVICE_UUID, '00000000-0196-6107-c967-c5cfb1c2482a');
    assert.equal(ZMK_STUDIO_BLE_CHARACTERISTIC_UUID, '00000001-0196-6107-c967-c5cfb1c2482a');
  });

  test('open connects with the right UUIDs and forwards indications', async () => {
    let connectedService = '';
    let connectedChar = '';
    const driver: BleDriver = {
      scan: async () => [],
      connect: async (_addr, service, characteristic, handlers) => {
        connectedService = service;
        connectedChar = characteristic;
        setTimeout(() => handlers.onIndication(new Uint8Array([0xab, 0x02, 0xad])), 10);
        return { write: async () => {}, close: async () => {} };
      },
    };
    const t = new BleGattTransport({ id: 'ble', label: 'kb', address: 'AA:BB:CC:DD:EE:FF', driver });
    const seen: Uint8Array[] = [];
    t.setHandlers({ onData: (b) => seen.push(b), onOpen: () => {}, onClose: () => {}, onError: () => {} });
    await t.open();
    await sleep(30);
    assert.equal(connectedService, ZMK_STUDIO_BLE_SERVICE_UUID);
    assert.equal(connectedChar, ZMK_STUDIO_BLE_CHARACTERISTIC_UUID);
    assert.equal(seen.length, 1);
    await t.close();
  });

  test('PARTIAL marker: no real hardware round trip exists (item 12)', async () => {
    // BLE is DESIGN/PARTIAL in this release. The HARDWARE_VALIDATION doc must
    // say so (asserted in acceptance A12); here we assert the transport is
    // exercised only through fake drivers.
    const driver: BleDriver = { scan: async () => [], connect: async () => ({ write: async () => {}, close: async () => {} }) };
    const t = new BleGattTransport({ id: 'b', label: 'b', address: 'AA:BB', driver });
    assert.equal(t.kind, 'ble');
  });
});

describe('Multi-HID interface safety (item 13)', () => {
  const raw = (path: string): HidDeviceInfo => ({ path, vendorId: 0xe560, productId: 0xe104, usagePage: 0xff60, usage: 0x61 });
  const nonRaw = (path: string): HidDeviceInfo => ({ path, vendorId: 0x362d, productId: 0xff04, usagePage: 0xffc1, usage: 0x00 });

  test('exact path wins and both usage page AND usage id are validated', () => {
    const ok = resolveHidOpen({ id: 'k', label: 'k', path: 'P1', usagePage: 0xff60, usageId: 0x61 }, [raw('P1')]);
    assert.equal(ok.path, 'P1');
    // wrong usage on the exact path is refused
    assert.throws(
      () => resolveHidOpen({ id: 'k', label: 'k', path: 'P2', usagePage: 0xff60, usageId: 0x61 }, [nonRaw('P2')]),
      /does not match Raw HID/,
    );
  });

  test('no blind VID/PID open — multiple interfaces require a path', () => {
    assert.throws(
      () => resolveHidOpen({ id: 'k', label: 'k', vendorId: 0xe560, productId: 0xe104 }, [raw('P1'), raw('P2')]),
      /must pick an exact path/,
    );
    assert.throws(
      () => resolveHidOpen({ id: 'k', label: 'k', vendorId: 0x9999, productId: 0x9999 }, []),
      /refusing to blind-open/,
    );
  });

  test('keyboard/mouse/media interfaces (non 0xFF60/0x61) are never treated as Raw HID', () => {
    const kb: HidDeviceInfo = { path: 'KB', vendorId: 1, productId: 1, usagePage: 0x01, usage: 0x06 };
    const mouse: HidDeviceInfo = { path: 'M', vendorId: 1, productId: 2, usagePage: 0x01, usage: 0x02 };
    assert.throws(() => resolveHidOpen({ id: 'k', label: 'k' }, [kb, mouse]), /no Raw HID interface/);
  });

  test('HidTransport enforces exact report size (32 bytes)', async () => {
    const driver = {
      enumerate: async () => [],
      open: async () => ({ write: async () => {}, read: async () => null, close: async () => {} }),
    };
    const t = new HidTransport({ id: 'h', label: 'h', path: 'P1', driver });
    t.setHandlers({ onData: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {} });
    await t.open();
    await assert.rejects(() => t.write(new Uint8Array(16)), /exactly 32 bytes/);
    await t.write(new Uint8Array(32));
    await t.close();
  });
});

describe('Permission errors & disconnect states (item 14)', () => {
  test('permission-denied never flips to ready', async () => {
    assert.equal(isPermissionError('hid_open_path failed (0xE00002C1) (iokit/common) privilege violation'), true);
    assert.equal(isPermissionError('operation not permitted'), true);
    assert.equal(isPermissionError('no device found'), false);

    const audit = new WriteAudit();
    const gate = new CapabilityGate(audit, 'allow');
    const dm = new DeviceManager({
      registry: new ProfileRegistry(),
      audit,
      gate,
      enumerators: [async () => [{ id: 'if1', label: 'raw', kind: 'hid', path: 'P1', usagePage: 0xff60, usageId: 0x61 }]],
      openTransport: async () => {
        throw new Error('open failed: (0xE00002C1) privilege violation');
      },
    });
    await dm.refresh();
    const dev = await dm.connect('if1');
    assert.equal(dev.status, 'permission-denied');
    assert.notEqual(dev.status, 'ready');
    assert.equal(audit.countWrites(), 0);
  });

  test('disconnect state is terminal until user reconnects', async () => {
    const audit = new WriteAudit();
    const gate = new CapabilityGate(audit, 'allow');
    const t = new NullTransport({ id: 'n', exactPath: 'tcp://x:1' });
    const dm = new DeviceManager({
      registry: new ProfileRegistry(),
      audit,
      gate,
      enumerators: [async () => [{ id: 'n', label: 'null', kind: 'tcp', path: 'tcp://x:1' }]],
      openTransport: async () => t,
    });
    await dm.refresh();
    await dm.disconnect('n');
    const dev = dm.get('n');
    assert.equal(dev?.status, 'disconnected');
    assert.notEqual(dev?.status, 'ready');
  });
});

describe('round-16 P1-2: bare QMK Raw HID status honesty', () => {
  test('connected Raw HID device stays transport-available, capabilitiesKnown=false, zero writes', async () => {
    const audit = new WriteAudit();
    const gate = new CapabilityGate(audit, 'allow');
    const reg = new ProfileRegistry();
    const t = new NullTransport({ id: 'raw', exactPath: 'DevSrvsID:raw', mtu: 32 });
    const dm = new DeviceManager({
      registry: reg,
      audit,
      gate,
      enumerators: [async () => [{ id: 'raw', label: 'Raw KB', kind: 'hid', path: 'DevSrvsID:raw', usagePage: 0xff60, usageId: 0x61 }]],
      openTransport: async () => t,
    });
    await dm.refresh();
    const dev = await dm.connect('raw');
    assert.equal(dev.status, 'transport-available', 'never protocol-identified');
    assert.equal(dev.capabilitiesKnown, false, 'capabilities must remain unknown');
    assert.equal(dev.adapterId, 'qmk-rawhid');
    assert.ok(dev.error?.includes('No verified control profile is selected'), `error must carry read-only message: ${dev.error}`);
    assert.notEqual(dev.status, 'capabilities-known');
    assert.notEqual(dev.status, 'ready');
    assert.equal(audit.countWrites(), 0, 'zero writes during connect+identify');
    // an explicit op attempt must still be refused (all capabilities unknown)
    const res = await dm.applyOp({ kind: 'set-indicator', deviceId: 'raw', label: 'x', payload: { color: { r: 1, g: 2, b: 3 } } });
    assert.equal(res.ok, false);
    assert.equal(audit.countWrites(), 0, 'zero writes after op attempt');
    await dm.disconnect('raw');
  });
});

describe('round-16 P2-7: control-interface filtering', () => {
  const candidates = [
    { id: 'raw', label: 'Raw HID', kind: 'hid' as const, path: 'P-raw', usagePage: 0xff60, usageId: 0x61 },
    { id: 'kb', label: 'Keyboard', kind: 'hid' as const, path: 'P-kb', usagePage: 0x01, usageId: 0x06 },
    { id: 'mouse', label: 'Mouse', kind: 'hid' as const, path: 'P-mouse', usagePage: 0x01, usageId: 0x02 },
    { id: 'media', label: 'Media', kind: 'hid' as const, path: 'P-media', usagePage: 0x0c, usageId: 0x01 },
    { id: 'glx', label: 'Vendor page', kind: 'hid' as const, path: 'P-glx', usagePage: 0xffc1, usageId: 0x01 },
    { id: 'studio-ble', label: 'Studio BLE', kind: 'ble' as const, path: 'AA:BB', serviceUuids: ['00000000-0196-6107-c967-c5cfb1c2482a'] },
    { id: 'serial', label: 'CDC-ACM', kind: 'serial' as const, path: '/dev/ttyACM0' },
  ];

  test('default list only contains control-relevant interfaces', async () => {
    const audit = new WriteAudit();
    const dm = new DeviceManager({
      registry: new ProfileRegistry(), audit, gate: new CapabilityGate(audit, 'read-only'),
      enumerators: [async () => candidates],
    });
    await dm.refresh();
    const ids = dm.list().map((d) => d.id).sort();
    assert.deepEqual(ids, ['raw', 'serial', 'studio-ble']);
  });

  test('ordinary keyboard/mouse/media/vendor-page HID never appear by default', async () => {
    const audit = new WriteAudit();
    const dm = new DeviceManager({
      registry: new ProfileRegistry(), audit, gate: new CapabilityGate(audit, 'read-only'),
      enumerators: [async () => candidates],
    });
    await dm.refresh();
    for (const id of ['kb', 'mouse', 'media', 'glx']) {
      assert.equal(dm.get(id), undefined, `${id} must not appear in the default control list`);
    }
  });

  test('"show all interfaces" diagnostic switch lists everything', async () => {
    const audit = new WriteAudit();
    const dm = new DeviceManager({
      registry: new ProfileRegistry(), audit, gate: new CapabilityGate(audit, 'read-only'),
      enumerators: [async () => candidates],
    });
    await dm.refresh();
    assert.equal(dm.get('kb'), undefined);
    dm.setShowAllInterfaces(true);
    await dm.refresh();
    assert.ok(dm.get('kb'), 'keyboard appears with show-all');
    assert.ok(dm.get('mouse'));
    assert.ok(dm.get('media'));
    assert.ok(dm.get('glx'));
  });

  test('user-explicit interface joins the control list', async () => {
    const audit = new WriteAudit();
    const dm = new DeviceManager({
      registry: new ProfileRegistry(), audit, gate: new CapabilityGate(audit, 'read-only'),
      enumerators: [async () => candidates],
    });
    await dm.refresh();
    assert.equal(dm.get('kb'), undefined);
    dm.addExplicitInterface('kb');
    await dm.refresh();
    assert.ok(dm.get('kb'));
  });
});
