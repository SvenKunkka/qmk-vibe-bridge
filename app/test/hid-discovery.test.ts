/**
 * HID discovery tests (round-15, generic). No vendor-specific test devices:
 * the safety rules are about ANY Raw HID interface — unknown interfaces stay
 * read-only with zero writes; multi-interface keyboards are never blind-opened.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHidOpen, type HidDeviceInfo } from '@vibebridge/core';

function raw(path: string, vid = 0xe560, pid = 0xe104): HidDeviceInfo {
  return { path, vendorId: vid, productId: pid, usagePage: 0xff60, usage: 0x61 };
}
function nonRaw(path: string, vid = 0x1234, pid = 0x5678, usagePage = 0xffc1, usage = 0x00): HidDeviceInfo {
  return { path, vendorId: vid, productId: pid, usagePage, usage };
}

describe('Raw HID discovery (round-15 generic)', () => {
  test('a Raw HID-looking interface (0xFF60/0x61) is recognized by usage page AND usage id', () => {
    const r = resolveHidOpen({ id: 'k', label: 'k', path: 'P1' }, [raw('P1')]);
    assert.equal(r.path, 'P1');
  });

  test('vendor-private usage pages (e.g. 0xFFC1) are NEVER opened', () => {
    assert.throws(
      () => resolveHidOpen({ id: 'k', label: 'k', path: 'P2' }, [nonRaw('P2')]),
      /does not match Raw HID/,
    );
  });

  test('no blind VID/PID open: multiple candidates require an exact path', () => {
    assert.throws(
      () => resolveHidOpen({ id: 'k', label: 'k', vendorId: 0xe560, productId: 0xe104 }, [raw('P1'), raw('P2')]),
      /must pick an exact path/,
    );
  });

  test('no candidate at all -> rejected, nothing opened', () => {
    assert.throws(
      () => resolveHidOpen({ id: 'k', label: 'k' }, []),
      /refusing to blind-open/,
    );
  });

  test('keyboard/mouse/media interfaces are never treated as Raw HID', () => {
    const kb: HidDeviceInfo = { path: 'KB', vendorId: 1, productId: 1, usagePage: 0x01, usage: 0x06 };
    const mouse: HidDeviceInfo = { path: 'M', vendorId: 1, productId: 2, usagePage: 0x01, usage: 0x02 };
    assert.throws(() => resolveHidOpen({ id: 'k', label: 'k' }, [kb, mouse]), /no Raw HID interface/);
  });

  test('a single unambiguous strict candidate resolves to its exact path', () => {
    const r = resolveHidOpen({ id: 'k', label: 'k', vendorId: 0xe560, productId: 0xe104 }, [raw('P1')]);
    assert.equal(r.path, 'P1');
  });
});
