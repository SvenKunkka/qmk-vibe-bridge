/**
 * USB CDC-ACM serial transport (round-15).
 *
 * Used by ZMK Studio over USB. Bytes flow as a plain UART stream; the ZMK
 * Studio framing (SoF 0xAB / Esc 0xAC / EoF 0xAD) is applied by the
 * zmk-studio adapter, NOT here. The platform driver is injected (e.g. the
 * `serialport` package in the app layer) so core stays dependency free.
 */

import type { DeviceTransport, TransportHandlers } from './types';

export interface SerialDriver {
  list(): Promise<SerialPortInfo[]>;
  open(path: string, opts?: { baud?: number }): Promise<SerialPortHandle>;
}

export interface SerialPortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
  product?: string;
}

export interface SerialPortHandle {
  write(bytes: Uint8Array): Promise<void>;
  /** resolves with the next chunk of bytes, or null when the port closes */
  read(): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export class SerialTransport implements DeviceTransport {
  readonly id: string;
  readonly kind = 'serial' as const;
  readonly label: string;
  readonly exactPath: string;
  readonly mtu: number | null = null;
  private readonly driver: SerialDriver;
  private readonly baud: number;
  private handle: SerialPortHandle | null = null;
  private handlers: TransportHandlers = { onData: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {} };
  private reading = false;
  private closedByUs = false;

  constructor(opts: { id: string; label: string; path: string; baud?: number; driver: SerialDriver }) {
    this.id = opts.id;
    this.label = opts.label;
    this.exactPath = opts.path;
    this.baud = opts.baud ?? 115200;
    this.driver = opts.driver;
  }

  async open(): Promise<void> {
    this.closedByUs = false;
    this.handle = await this.driver.open(this.exactPath, { baud: this.baud });
    this.handlers.onOpen();
    this.startReadLoop();
  }

  private startReadLoop(): void {
    if (this.reading) return;
    this.reading = true;
    void (async () => {
      while (this.reading && this.handle) {
        try {
          const chunk = await this.handle.read();
          if (chunk === null) {
            this.reading = false;
            this.handlers.onClose(this.closedByUs ? undefined : new Error('serial read ended'));
            return;
          }
          this.handlers.onData(chunk);
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
    if (!this.handle) throw new Error('serial transport not open');
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
