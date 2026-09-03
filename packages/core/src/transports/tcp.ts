/**
 * TCP transports (round-15): used by the simulator. The TCP framing is a
 * 2-byte little-endian length prefix + raw payload — a TRANSPORT-level framing
 * only; it carries whatever byte stream the simulator's virtual device speaks
 * (AKP, VIA, ZMK Studio, or plain Raw HID reports).
 */

import * as net from 'node:net';
import type { DeviceTransport, TransportHandlers } from './types';

export interface TcpSimulatorConfig {
  id: string;
  label: string;
  host: string;
  port: number;
}

/** Client transport to the virtual keyboard simulator. */
export class TcpSimulatorTransport implements DeviceTransport {
  readonly id: string;
  readonly kind = 'tcp' as const;
  readonly label: string;
  readonly exactPath: string;
  readonly mtu: number | null = null;
  private readonly host: string;
  private readonly port: number;
  private socket: net.Socket | null = null;
  private handlers: TransportHandlers = { onData: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {} };
  private parser = new LengthPrefixedParser();
  private closedByUs = false;

  constructor(cfg: TcpSimulatorConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.host = cfg.host;
    this.port = cfg.port;
    this.exactPath = `tcp://${cfg.host}:${cfg.port}`;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closedByUs = false;
      this.parser.reset();
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      let opened = false;
      socket.on('connect', () => {
        opened = true;
        this.handlers.onOpen();
        resolve();
      });
      socket.on('data', (chunk: Buffer) => {
        for (const msg of this.parser.push(chunk)) {
          this.handlers.onData(msg);
        }
      });
      socket.on('error', (err) => {
        if (!opened) reject(err);
        this.handlers.onError(err);
      });
      socket.on('close', () => {
        this.socket = null;
        this.handlers.onClose(this.closedByUs ? undefined : new Error('connection closed'));
      });
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = this.socket;
      if (!s || s.destroyed || this.closedByUs) {
        reject(new Error('transport not connected'));
        return;
      }
      const len = Buffer.alloc(2);
      len.writeUInt16LE(bytes.length, 0);
      s.write(Buffer.concat([len, Buffer.from(bytes)]), (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    this.closedByUs = true;
    return new Promise((resolve) => {
      const s = this.socket;
      if (s && !s.destroyed) {
        s.end(() => {
          s.destroy();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }
}

/** Server-side TCP transport: wraps an accepted net.Socket. */
export class TcpServerTransport implements DeviceTransport {
  readonly id: string;
  readonly kind = 'tcp' as const;
  readonly label: string;
  readonly exactPath: string;
  readonly mtu: number | null = null;
  private socket: net.Socket;
  private handlers: TransportHandlers = { onData: () => {}, onOpen: () => {}, onClose: () => {}, onError: () => {} };
  private parser = new LengthPrefixedParser();
  private attached = false;

  constructor(socket: net.Socket, id = 'tcp', label = 'tcp') {
    this.socket = socket;
    this.id = id;
    this.label = label;
    this.exactPath = `tcp://${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.parser.reset();
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk: Buffer) => {
      for (const msg of this.parser.push(chunk)) {
        this.handlers.onData(msg);
      }
    });
    this.socket.on('error', (err) => this.handlers.onError(err));
    this.socket.on('close', () => this.handlers.onClose());
  }

  open(): Promise<void> {
    this.attach();
    this.handlers.onOpen();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket && !this.socket.destroyed) {
        this.socket.end(() => {
          this.socket.destroy();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('transport not connected'));
        return;
      }
      const len = Buffer.alloc(2);
      len.writeUInt16LE(bytes.length, 0);
      this.socket.write(Buffer.concat([len, Buffer.from(bytes)]), (err) => (err ? reject(err) : resolve()));
    });
  }

  setHandlers(h: TransportHandlers): void {
    this.handlers = h;
  }
}

/** 2-byte LE length-prefixed frame parser (transport framing). */
export class LengthPrefixedParser {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer): Uint8Array[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Uint8Array[] = [];
    while (this.buf.length >= 2) {
      const len = this.buf.readUInt16LE(0);
      if (this.buf.length < 2 + len) break;
      out.push(new Uint8Array(this.buf.subarray(2, 2 + len)));
      this.buf = this.buf.subarray(2 + len);
    }
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
