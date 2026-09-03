/**
 * BLE GATT transport (round-15).
 *
 * ZMK Studio over BLE uses a custom GATT service:
 *   Service UUID:        00000000-0196-6107-c967-c5cfb1c2482a
 *   Characteristic UUID: 00000001-0196-6107-c967-c5cfb1c2482a
 * Writes carry framed client messages; the device uses GATT Indications to
 * send framed messages back.
 *
 * STATUS: DESIGN/PARTIAL. No real BLE host integration has been verified on
 * hardware yet — anything claiming BLE success must be marked Partial until a
 * real device round-trip completes (round-15 acceptance #12).
 */

import type { DeviceTransport, TransportHandlers } from './types';

export const ZMK_STUDIO_BLE_SERVICE_UUID = '00000000-0196-6107-c967-c5cfb1c2482a';
export const ZMK_STUDIO_BLE_CHARACTERISTIC_UUID = '00000001-0196-6107-c967-c5cfb1c2482a';

export interface BleDeviceInfo {
  address: string;
  name?: string;
  serviceUuids: string[];
}

export interface BleDriver {
  scan(): Promise<BleDeviceInfo[]>;
  connect(
    address: string,
    serviceUuid: string,
    characteristicUuid: string,
    handlers: {
      onIndication(data: Uint8Array): void;
      onDisconnected(err?: Error): void;
    },
  ): Promise<BleConnection>;
}

export interface BleConnection {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export class BleGattTransport implements DeviceTransport {
  readonly id: string;
  readonly kind = 'ble' as const;
  readonly label: string;
  readonly exactPath: string;
  readonly mtu: number | null = null;
  private readonly driver: BleDriver;
  private readonly serviceUuid: string;
  private readonly characteristicUuid: string;
  private conn: BleConnection | null = null;
  private handlers: TransportHandlers = { onData: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {} };
  private closedByUs = false;

  constructor(opts: {
    id: string;
    label: string;
    address: string;
    serviceUuid?: string;
    characteristicUuid?: string;
    driver: BleDriver;
  }) {
    this.id = opts.id;
    this.label = opts.label;
    this.exactPath = `ble://${opts.address}/${opts.serviceUuid ?? ZMK_STUDIO_BLE_SERVICE_UUID}`;
    this.serviceUuid = opts.serviceUuid ?? ZMK_STUDIO_BLE_SERVICE_UUID;
    this.characteristicUuid = opts.characteristicUuid ?? ZMK_STUDIO_BLE_CHARACTERISTIC_UUID;
    this.driver = opts.driver;
  }

  async open(): Promise<void> {
    this.closedByUs = false;
    this.conn = await this.driver.connect(this.exactPath.slice('ble://'.length).split('/')[0], this.serviceUuid, this.characteristicUuid, {
      onIndication: (data) => this.handlers.onData(data),
      onDisconnected: (err) => {
        if (!this.closedByUs) this.handlers.onClose(err);
      },
    });
    this.handlers.onOpen();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.conn) throw new Error('ble transport not open');
    await this.conn.write(bytes);
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      await c.close();
    }
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }
}
