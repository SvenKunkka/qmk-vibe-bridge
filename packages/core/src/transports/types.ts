/**
 * Transport Layer (round-15). Transports ONLY discover, open, read, write and
 * close byte streams to a keyboard — they never interpret business commands.
 * Protocol interpretation belongs to Protocol Adapters.
 *
 * Kinds: usb-hid (Raw HID), usb-cdc-acm (serial), ble-gatt, tcp (simulator).
 */

export type TransportKind = 'hid' | 'serial' | 'ble' | 'tcp';

export interface TransportHandlers {
  onData(bytes: Uint8Array): void;
  onOpen(): void;
  onClose(err?: Error): void;
  onError(err: Error): void;
}

export interface DeviceTransport {
  readonly id: string;
  readonly kind: TransportKind;
  readonly label: string;
  /**
   * Exact endpoint (HID path / serial device path / BLE device+service /
   * TCP addr). A transport WITHOUT an exact path must refuse to open —
   * VID/PID blind-open is forbidden (round-15).
   */
  readonly exactPath: string | null;
  /** fixed report size for HID transports (QMK Raw HID: 32); null otherwise */
  readonly mtu: number | null;
  open(): Promise<void>;
  close(): Promise<void>;
  /** raw byte write (transport framing only, no protocol bytes added) */
  write(bytes: Uint8Array): Promise<void>;
  setHandlers(h: TransportHandlers): void;
}

export interface TransportFactory {
  readonly kind: TransportKind;
  /** enumerate interfaces; the app layer injects platform drivers */
  enumerate(): Promise<TransportCandidate[]>;
  open(candidate: TransportCandidate): Promise<DeviceTransport>;
}

export interface TransportCandidate {
  id: string;
  label: string;
  kind: TransportKind;
  path?: string;
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usageId?: number;
  /** BLE: GATT service UUIDs */
  serviceUuids?: string[];
  /** BLE: characteristic UUID for writes (ZMK Studio: …c5cfb1c2482a) */
  writeCharacteristic?: string;
  mtu?: number;
  /** serial: baud rate etc. */
  serial?: { baud?: number };
}

/** A transport that does not require an exact path (test double). */
export class NullTransport implements DeviceTransport {
  readonly id: string;
  readonly kind: TransportKind;
  readonly label: string;
  readonly exactPath: string | null;
  readonly mtu: number | null;
  private handlers: TransportHandlers = { onData: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {} };
  written: Uint8Array[] = [];
  openCalled = false;
  closeCalled = false;
  private opened = false;

  constructor(opts: { id?: string; kind?: TransportKind; label?: string; exactPath?: string | null; mtu?: number | null } = {}) {
    this.id = opts.id ?? 'null';
    this.kind = opts.kind ?? 'tcp';
    this.label = opts.label ?? 'null';
    this.exactPath = opts.exactPath ?? null;
    this.mtu = opts.mtu ?? null;
  }

  async open(): Promise<void> {
    this.openCalled = true;
    this.opened = true;
    this.handlers.onOpen();
  }
  async close(): Promise<void> {
    this.closeCalled = true;
    this.opened = false;
    this.handlers.onClose();
  }
  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(bytes);
  }
  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }
  /** simulate inbound bytes from the "device" */
  deliver(bytes: Uint8Array): void {
    this.handlers.onData(bytes);
  }
  get isOpen(): boolean {
    return this.opened;
  }
}
