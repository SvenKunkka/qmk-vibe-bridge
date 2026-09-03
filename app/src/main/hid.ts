/**
 * Real HID support via node-hid (round-15).
 *
 * node-hid is a native module, loaded lazily so the app still boots if the
 * native build is missing (virtual/simulator flows keep working). This file
 * provides:
 *   - enumerateHidCandidates(): every HID interface annotated with its
 *     usage page/usage id (the core's ProfileRegistry decides what matches);
 *   - an HidDriver implementation (exact-path open only; 33-byte node-hid
 *     writes with report id 0x00 for Raw HID);
 *   - enumerator + opener factories injected into ConsoleCore.
 *
 * Hard rules (round-15): open by exact path only; validate BOTH usage page
 * and usage id for Raw HID; never blind-open by VID/PID; never treat
 * keyboard/mouse/media interfaces as Raw HID.
 */

import type { ProfileRegistry, TransportCandidate, DeviceTransport } from '@vibebridge/core';
import { HidTransport, isQmkRawHidInterface, QMK_RAW_HID_REPORT_SIZE, type HidDriver, type HidDeviceInfo } from '@vibebridge/core';

/** Enumerate HID interfaces, keeping only QMK-control-relevant ones
 *  (strict QMK Raw HID usage page 0xFF60 / usage 0x61). Everything else —
 *  ordinary keyboards, mice, media, vendor-private interfaces — is filtered
 *  out here so the app only ever lists keyboards that expose a QMK control
 *  path. */
export function enumerateHidCandidates(): HidDeviceInfo[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const hid = require('node-hid') as typeof import('node-hid');
    return (hid.devices() as Array<{
      vendorId: number; productId: number; path?: string; product?: string; manufacturer?: string; usagePage?: number; usage?: number; interface?: number;
    }>)
      .filter((d) => isQmkRawHidInterface(d.usagePage, d.usage))
      .map((d) => ({
        vendorId: d.vendorId,
        productId: d.productId,
        path: d.path,
        product: d.product,
        manufacturer: d.manufacturer,
        usagePage: d.usagePage,
        usage: d.usage,
        interface: d.interface,
      }));
  } catch {
    return [];
  }
}

/** Enumerator for the core: all HID interfaces as transport candidates. */
export async function hidEnumerator(): Promise<TransportCandidate[]> {
  return enumerateHidCandidates().map((d) => ({
    id: d.path ?? `hid:${d.vendorId.toString(16)}:${d.productId.toString(16)}:${d.interface ?? 0}`,
    label: d.product ?? `HID ${d.vendorId.toString(16)}:${d.productId.toString(16)}`,
    kind: 'hid' as const,
    path: d.path,
    vendorId: d.vendorId,
    productId: d.productId,
    usagePage: d.usagePage,
    usageId: d.usage,
    mtu: isQmkRawHidInterface(d.usagePage, d.usage) ? QMK_RAW_HID_REPORT_SIZE : undefined,
  }));
}

/** node-hid driver: exact-path open; Raw HID writes get report id 0x00. */
export const nodeHidDriver: HidDriver = {
  async enumerate(): Promise<HidDeviceInfo[]> {
    return enumerateHidCandidates();
  },
  async open(path: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const hid = require('node-hid') as typeof import('node-hid');
    const device = new hid.HID(path);
    return {
      write: async (report: Uint8Array) => {
        // Raw HID reports need a report-id prefix byte (0x00) for node-hid
        const buf = Buffer.alloc(report.length + 1);
        buf[0] = 0x00;
        buf.set(Buffer.from(report), 1);
        device.write(buf);
      },
      read: () =>
        new Promise<Uint8Array | null>((resolve, reject) => {
          device.once('data', (buf: Buffer) => resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
          device.once('error', (err: Error) => reject(err));
        }),
      close: async () => {
        try {
          device.close();
        } catch {
          /* ignore */
        }
      },
    };
  },
};

/** Open a transport for a candidate (used as ConsoleCore openTransport). */
export async function openHidTransport(candidate: TransportCandidate): Promise<DeviceTransport> {
  if (candidate.kind !== 'hid') throw new Error(`cannot open non-HID candidate kind ${candidate.kind}`);
  if (!candidate.path) throw new Error('HID transport requires an exact path (no blind VID/PID open)');
  return new HidTransport({
    id: candidate.id,
    label: candidate.label,
    path: candidate.path,
    mtu: candidate.mtu ?? QMK_RAW_HID_REPORT_SIZE,
    driver: nodeHidDriver,
  });
}

/** Convenience: console core enumerators + opener (hid only). */
export function hidIntegration() {
  return {
    enumerateInterfaces: [async (_registry: ProfileRegistry) => hidEnumerator()],
    openTransport: openHidTransport,
  };
}
