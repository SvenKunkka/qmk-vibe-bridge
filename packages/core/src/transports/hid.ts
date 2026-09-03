/**
 * USB HID / Raw HID transport (round-15).
 *
 * Follows the QMK Raw HID specification:
 *   - default Usage Page 0xFF60, Usage ID 0x61
 *   - HID reports fixed at 32 bytes (RAW_EPSIZE)
 *   - open by exact interface path; validate BOTH usage page and usage id
 *   - never blind-open by VID/PID
 *
 * The platform driver (node-hid etc.) is injected so core stays dependency
 * free and the app layer owns native bindings.
 */

import type { DeviceTransport, TransportCandidate, TransportHandlers, TransportKind } from './types';
import { QMK_RAW_HID_PAGE, QMK_RAW_HID_USAGE, QMK_RAW_HID_REPORT_SIZE, isQmkRawHidInterface } from '../profiles/builtin';

export interface HidDriver {
  enumerate(): Promise<HidDeviceInfo[]>;
  open(path: string): Promise<HidDeviceHandle>;
}

export interface HidDeviceInfo {
  path?: string;
  vendorId: number;
  productId: number;
  usagePage?: number;
  usage?: number;
  product?: string;
  manufacturer?: string;
  interface?: number;
}

export interface HidDeviceHandle {
  write(report: Uint8Array): Promise<void>;
  read(): Promise<Uint8Array | null>; // null => closed
  close(): Promise<void>;
}

export interface HidCandidateConfig {
  id: string;
  label: string;
  path?: string;
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usageId?: number;
  mtu?: number;
}

/**
 * Resolve which candidate to open. STRICT: a candidate without an exact path
 * is refused; a candidate whose usage page/usage id are known but do not
 * match 0xFF60/0x61 is refused. Returns the resolved open spec.
 */
export function resolveHidOpen(
  cfg: HidCandidateConfig,
  devices: HidDeviceInfo[],
): { path: string; mtu: number } {
  if (cfg.path) {
    const exact = devices.find((d) => d.path === cfg.path);
    if (!exact) throw new Error(`interface not found at path ${cfg.path}`);
    // round-15: validate BOTH usage page AND usage id even for exact paths —
    // a Raw HID resolver must never open a keyboard/mouse/media interface
    if (exact.usagePage !== QMK_RAW_HID_PAGE || exact.usage !== QMK_RAW_HID_USAGE) {
      throw new Error(
        `interface ${cfg.path} does not match Raw HID 0x${QMK_RAW_HID_PAGE.toString(16)}/0x${QMK_RAW_HID_USAGE.toString(16)} ` +
        `(got 0x${(exact.usagePage ?? 0).toString(16)}/0x${(exact.usage ?? 0).toString(16)})`,
      );
    }
    return { path: exact.path ?? cfg.path, mtu: cfg.mtu ?? QMK_RAW_HID_REPORT_SIZE };
  }
  // no path: only a SINGLE unambiguous strict candidate may be converted to its path
  const strict = devices.filter((d) => isQmkRawHidInterface(d.usagePage, d.usage));
  const vidPid = strict.filter(
    (d) =>
      cfg.vendorId !== undefined && cfg.productId !== undefined &&
      d.vendorId === cfg.vendorId && d.productId === cfg.productId,
  );
  const pool = vidPid.length > 0 ? vidPid : strict;
  if (pool.length === 0) {
    throw new Error('no Raw HID interface (0xFF60/0x61) found — refusing to blind-open by VID/PID');
  }
  if (pool.length > 1) {
    throw new Error(`multiple Raw HID interfaces (${pool.length}) — user must pick an exact path`);
  }
  if (!pool[0].path) throw new Error('Raw HID interface has no usable path — cannot open');
  return { path: pool[0].path, mtu: cfg.mtu ?? QMK_RAW_HID_REPORT_SIZE };
}

export function toTransportCandidates(devices: HidDeviceInfo[]): TransportCandidate[] {
  return devices.map((d) => ({
    id: d.path ?? `hid:${d.vendorId.toString(16)}:${d.productId.toString(16)}`,
    label: d.product ?? `HID ${d.vendorId.toString(16)}:${d.productId.toString(16)}`,
    kind: 'hid' as TransportKind,
    path: d.path,
    vendorId: d.vendorId,
    productId: d.productId,
    usagePage: d.usagePage,
    usageId: d.usage,
    mtu: isQmkRawHidInterface(d.usagePage, d.usage) ? QMK_RAW_HID_REPORT_SIZE : undefined,
  }));
}

/** Raw HID transport over an injected platform driver. */
export class HidTransport implements DeviceTransport {
  readonly id: string;
  readonly kind = 'hid' as const;
  readonly label: string;
  readonly exactPath: string;
  readonly mtu: number;
  private readonly driver: HidDriver;
  private handle: HidDeviceHandle | null = null;
  private handlers: TransportHandlers = { onData: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {} };
  private closedByUs = false;
  private reading = false;

  constructor(opts: { id: string; label: string; path: string; mtu?: number; driver: HidDriver }) {
    this.id = opts.id;
    this.label = opts.label;
    this.exactPath = opts.path;
    this.mtu = opts.mtu ?? QMK_RAW_HID_REPORT_SIZE;
    this.driver = opts.driver;
  }

  async open(): Promise<void> {
    this.closedByUs = false;
    this.handle = await this.driver.open(this.exactPath);
    this.handlers.onOpen();
    this.startReadLoop();
  }

  private startReadLoop(): void {
    if (this.reading) return;
    this.reading = true;
    void (async () => {
      while (this.reading && this.handle) {
        try {
          const report = await this.handle.read();
          if (report === null) {
            this.reading = false;
            this.handlers.onClose(this.closedByUs ? undefined : new Error('hid read ended'));
            return;
          }
          this.handlers.onData(report);
        } catch (err) {
          this.reading = false;
          this.handlers.onError(err as Error);
          this.handlers.onClose(err as Error);
          return;
        }
      }
    })();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.handle) throw new Error('transport not open');
    if (bytes.length !== this.mtu) {
      throw new Error(`Raw HID reports must be exactly ${this.mtu} bytes (got ${bytes.length})`);
    }
    await this.handle.write(bytes);
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.reading = false;
    if (this.handle) {
      const h = this.handle;
      this.handle = null;
      await h.close();
    }
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }
}
