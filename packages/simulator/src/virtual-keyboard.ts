/**
 * VirtualKeyboardServer (round-15) — simulates keyboards over TCP so the whole
 * pipeline runs without hardware. MODES:
 *
 *   akp            : AKP extension device role (HELLO handshake, STATE/RGB/SCREEN)
 *   unknown-rawhid : a Raw HID keyboard that speaks NOTHING — used to prove
 *                    unknown devices stay read-only with zero writes
 *   via            : VIA protocol device (GET_PROTOCOL_VERSION etc.)
 *   zmk-studio     : ZMK Studio RPC device (framed protobuf)
 *   simulator      : the project's own JSON simulator protocol
 *
 * Simulator results never substitute for real protocol verification.
 */

import * as net from 'node:net';
import { AgentState, colorForState, rgbToHex, type RGB } from '@vibebridge/akp-codec';
import { AkpSession, TcpServerTransport, type DeviceTransport, ZmkFrameStream, zmkFrameEncode, pbDecode, pbAsVarint, encodeGetDeviceInfoResponse, encodeLockStateResponse, encodeSimpleErrorResponse, encodeKeymapResponse, encodeLockStateNotification } from '@vibebridge/core';

export type VirtualKeyboardMode = 'akp' | 'unknown-rawhid' | 'via' | 'zmk-studio' | 'simulator';

export interface VirtualKeyboardOptions {
  host?: string;
  port?: number;
  mtu?: number;
  mode?: VirtualKeyboardMode;
  fwVersion?: string;
  /** zmk-studio: device name reported by get_device_info */
  studioDeviceName?: string;
  /** zmk-studio: start unlocked? (ZMK Studio starts locked in reality) */
  studioUnlocked?: boolean;
  /** via: protocol version to answer (VIA_PROTOCOL_VERSION 0x000D) */
  viaProtocolVersion?: number;
  /** via: lighting channels the firmware compiles (1=backlight,2=rgblight,3=rgb_matrix) */
  viaChannels?: number[];
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  onState?: (state: AgentState, color: RGB) => void;
  onScreen?: (lines: string[]) => void;
  onRgbPerKey?: (count: number) => void;
}

interface DeviceStats {
  bytesIn: number;
  bytesOut: number;
  writeCount: number;
}

export class VirtualKeyboardServer {
  readonly options: Required<Omit<VirtualKeyboardOptions, 'onState' | 'onScreen' | 'onRgbPerKey' | 'studioUnlocked' | 'studioDeviceName' | 'viaProtocolVersion' | 'viaChannels'>> & VirtualKeyboardOptions;
  private server: net.Server | null = null;
  private sessions = new Set<AkpSession>();
  private stats = new Map<DeviceTransport, DeviceStats>();
  private connected = false;
  /** zmk-studio mode: lock state (starts locked unless studioUnlocked) */
  private studioUnlocked: boolean;
  /** zmk-studio mode: connected transports that receive notifications */
  private studioTransports = new Set<DeviceTransport>();

  constructor(options: VirtualKeyboardOptions = {}) {
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 18902,
      mtu: options.mtu ?? 32,
      mode: options.mode ?? 'akp',
      fwVersion: options.fwVersion ?? '0.9.0',
      onLog: options.onLog ?? (() => {}),
      ...options,
    };
    this.studioUnlocked = options.studioUnlocked ?? false;
  }

  /**
   * zmk-studio mode: simulate the PHYSICAL unlock action on the keyboard.
   * The firmware broadcasts core.Notification.lock_state_changed to the host.
   */
  simulatePhysicalUnlock(): boolean {
    if (this.options.mode !== 'zmk-studio') return false;
    if (this.studioUnlocked) return true;
    this.studioUnlocked = true;
    this.options.onLog?.('info', '[vkb:zmk-studio] PHYSICAL unlock performed on keyboard — broadcasting lock_state_changed');
    const notif = zmkFrameEncode(encodeLockStateNotification(true));
    for (const t of this.studioTransports) {
      void t.write(notif).catch(() => {});
    }
    return true;
  }

  get isStudioUnlocked(): boolean {
    return this.studioUnlocked;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      server.on('error', reject);
      server.listen(this.options.port!, this.options.host!, () => {
        const addr = server.address() as net.AddressInfo;
        this.options.onLog?.('info', `[vkb] virtual keyboard (${this.options.mode}) listening on ${this.options.host}:${addr.port}`);
        resolve(addr.port);
      });
    });
  }

  async stop(): Promise<void> {
    for (const s of this.sessions) await s.stop().catch(() => {});
    this.sessions.clear();
    this.connected = false;
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      (this.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    this.server = null;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** total bytes the host wrote to this simulator (0 for unknown-rawhid) */
  totalHostWrites(): number {
    let n = 0;
    for (const s of this.stats.values()) n += s.writeCount;
    return n;
  }

  private onConnection(socket: net.Socket): void {
    this.options.onLog?.('info', '[vkb] host connected');
    this.connected = true;
    const transport = new TcpServerTransport(socket, 'vkb', 'virtual-keyboard');
    this.stats.set(transport, { bytesIn: 0, bytesOut: 0, writeCount: 0 });

    switch (this.options.mode) {
      case 'akp':
        this.runAkp(transport);
        break;
      case 'unknown-rawhid':
        this.runUnknownRawHid(transport);
        void transport.open();
        break;
      case 'via':
        this.runVia(transport);
        void transport.open();
        break;
      case 'zmk-studio':
        this.runZmkStudio(transport);
        void transport.open();
        break;
      case 'simulator':
        this.runSimulator(transport);
        void transport.open();
        break;
      default:
        this.runUnknownRawHid(transport);
        void transport.open();
    }
  }

  private count(transport: DeviceTransport): DeviceStats {
    const s = this.stats.get(transport) ?? { bytesIn: 0, bytesOut: 0, writeCount: 0 };
    return s;
  }

  private runAkp(transport: DeviceTransport): void {
    const session = new AkpSession(transport, {
      role: 'device',
      mtu: this.options.mtu!,
      heartbeatMs: 3000,
      onLog: this.options.onLog,
    });
    session.on('onCaps', (caps) => {
      this.options.onLog?.('info', `[vkb] caps received: features=${caps.features?.join(',') ?? 'none'}`);
    });
    session.on('onState', (state) => {
      const s = state.state as AgentState;
      const color = state.color ?? colorForState(s);
      this.options.onLog?.('info', `[vkb] STATE ${s} rgb=${rgbToHex(color)} text=${state.text ?? ''}`);
      this.options.onState?.(s, color);
    });
    session.on('onRgb', (json, raw) => {
      if (raw.length > 0 && (raw[0] === 0x01 || raw[0] === 0x03)) {
        const count = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint16(1, true);
        this.options.onLog?.('info', `[vkb] RGB per-key: ${count} leds`);
        this.options.onRgbPerKey?.(count);
      } else if (json && typeof json === 'object') {
        const j = json as { mode?: string; color?: RGB; brightness?: number };
        this.options.onLog?.('info', `[vkb] RGB ${j.mode ?? '?'} ${j.color ? rgbToHex(j.color) : ''} b=${j.brightness ?? '-'}`);
      }
    });
    session.on('onScreen', (screen) => {
      this.options.onLog?.('info', `[vkb] SCREEN: ${(screen.lines ?? []).join(' | ')}`);
      this.options.onScreen?.(screen.lines ?? []);
    });
    session.on('onHeartbeat', () => {
      void session.sendHeartbeat({ t: Math.floor(Date.now() / 1000), state: AgentState.IDLE });
    });
    session.on('onDisconnected', () => {
      this.connected = false;
      this.options.onLog?.('warn', '[vkb] host disconnected');
    });
    void session.start().then(() => {
      this.options.onLog?.('info', '[vkb] HELLO sent (AKP device role)');
    });
    this.sessions.add(session);
  }

  private runUnknownRawHid(transport: DeviceTransport): void {
    // speaks NOTHING — receives reports, never responds, never initiates
    transport.setHandlers({
      onData: (b) => {
        const s = this.count(transport);
        s.bytesIn += b.length;
        s.writeCount += 1;
        this.options.onLog?.('info', `[vkb:unknown-rawhid] host wrote ${b.length} bytes (ignored — no protocol)`);
      },
      onOpen: () => this.options.onLog?.('info', '[vkb:unknown-rawhid] transport open, silent device'),
      onClose: () => {
        this.connected = false;
        this.options.onLog?.('warn', '[vkb:unknown-rawhid] host disconnected');
      },
      onError: (e) => this.options.onLog?.('error', `[vkb:unknown-rawhid] ${e.message}`),
    });
  }

  private runVia(transport: DeviceTransport): void {
    const version = this.options.viaProtocolVersion ?? 0x000d;
    const channels = new Set(this.options.viaChannels ?? [1, 2, 3]);
    // lighting state per channel+value (official via channels)
    const state = new Map<string, number>();
    transport.setHandlers({
      onData: (b) => {
        const s = this.count(transport);
        s.bytesIn += b.length;
        s.writeCount += 1;
        const report = b.length >= 32 ? b.subarray(0, 32) : b;
        const cmd = report[0];
        const reply = new Uint8Array(32);
        reply[0] = cmd;
        if (cmd === 0x01) {
          // GET_PROTOCOL_VERSION
          reply[1] = (version >> 8) & 0xff;
          reply[2] = version & 0xff;
          this.options.onLog?.('info', `[vkb:via] GET_PROTOCOL_VERSION -> 0x${version.toString(16).padStart(4, '0')}`);
        } else if (cmd === 0x07) {
          // id_custom_set_value [channel, value_id, data...]
          const channel = report[1];
          if (!channels.has(channel)) {
            reply[0] = 0xff; // id_unhandled
            this.options.onLog?.('warn', `[vkb:via] set on unsupported channel ${channel} -> 0xFF`);
          } else {
            reply.set(report.subarray(0, 3), 0); // echo cmd+channel+value_id
            for (let i = 3; i < report.length; i++) {
              state.set(`c${channel}:v${report[2]}:${i - 3}`, report[i]);
            }
            this.options.onLog?.('info', `[vkb:via] set channel ${channel} value ${report[2]}`);
          }
        } else if (cmd === 0x08) {
          // id_custom_get_value [channel, value_id] -> echo + current value
          const channel = report[1];
          const valueId = report[2];
          if (!channels.has(channel)) {
            reply[0] = 0xff; // id_unhandled
            this.options.onLog?.('warn', `[vkb:via] get on unsupported channel ${channel} -> 0xFF`);
          } else {
            reply.set(report.subarray(0, 3), 0); // echo cmd+channel+value_id
            // default state: brightness 255, color blue (hue 170, sat 255)
            for (let i = 0; i < 4; i++) {
              const v = state.get(`c${channel}:v${valueId}:${i}`);
              reply[3 + i] = v !== undefined ? v : i === 0 ? 255 : i === 1 && valueId === 4 ? 170 : 255;
            }
            this.options.onLog?.('info', `[vkb:via] get channel ${channel} value ${valueId}`);
          }
        } else {
          // the-via/app validates that the reply echoes the command bytes
          reply.set(report.subarray(0, Math.min(report.length, 32)), 0);
          this.options.onLog?.('info', `[vkb:via] cmd 0x${cmd.toString(16)} echoed (${report.length} bytes)`);
        }
        void transport.write(reply).catch(() => {});
        s.bytesOut += reply.length;
      },
      onOpen: () => this.options.onLog?.('info', '[vkb:via] transport open'),
      onClose: () => {
        this.connected = false;
        this.options.onLog?.('warn', '[vkb:via] host disconnected');
      },
      onError: (e) => this.options.onLog?.('error', `[vkb:via] ${e.message}`),
    });
  }

  private runZmkStudio(transport: DeviceTransport): void {
    const stream = new ZmkFrameStream();
    this.studioTransports.add(transport);
    transport.setHandlers({
      onData: (b) => {
        const s = this.count(transport);
        s.bytesIn += b.length;
        s.writeCount += 1;
        for (const payload of stream.push(b)) {
          void this.handleStudioRequest(transport, payload, (reply) => {
            s.bytesOut += reply.length;
            void transport.write(reply).catch(() => {});
          });
        }
      },
      onOpen: () => this.options.onLog?.('info', '[vkb:zmk-studio] transport open'),
      onClose: () => {
        this.connected = false;
        this.studioTransports.delete(transport);
        this.options.onLog?.('warn', '[vkb:zmk-studio] host disconnected');
      },
      onError: (e) => this.options.onLog?.('error', `[vkb:zmk-studio] ${e.message}`),
    });
  }

  private async handleStudioRequest(
    transport: DeviceTransport,
    payload: Uint8Array,
    send: (reply: Uint8Array) => void,
  ): Promise<void> {
    const fields = pbDecode(payload);
    const requestId = pbAsVarint(fields.find((f) => f.field === 1)?.value) ?? 0;
    const core = fields.find((f) => f.field === 3)?.value;
    const keymap = fields.find((f) => f.field === 5)?.value;
    if (core?.kind === 'bytes') {
      const coreFields = pbDecode(core.value);
      const getInfo = pbAsVarint(coreFields.find((f) => f.field === 1)?.value);
      const getLock = pbAsVarint(coreFields.find((f) => f.field === 2)?.value);
      const lock = pbAsVarint(coreFields.find((f) => f.field === 3)?.value);
      if (getInfo !== undefined) {
        this.options.onLog?.('info', '[vkb:zmk-studio] get_device_info');
        send(zmkFrameEncode(encodeGetDeviceInfoResponse(requestId, this.options.studioDeviceName ?? 'Virtual Studio Keyboard', new Uint8Array([0x56, 0x49, 0x52, 0x54, 0x55, 0x41, 0x4c]))));
        return;
      }
      if (getLock !== undefined) {
        this.options.onLog?.('info', `[vkb:zmk-studio] get_lock_state -> ${this.studioUnlocked ? 'unlocked' : 'locked'}`);
        send(zmkFrameEncode(encodeLockStateResponse(requestId, this.studioUnlocked)));
        return;
      }
      if (lock !== undefined) {
        // official core.proto: the lock RPC LOCKS the keyboard (no toggle)
        this.studioUnlocked = false;
        this.options.onLog?.('info', '[vkb:zmk-studio] lock RPC -> locked');
        send(zmkFrameEncode(encodeLockStateResponse(requestId, false)));
        return;
      }
      send(zmkFrameEncode(encodeSimpleErrorResponse(requestId, 3))); // MSG_DECODE_FAILED
      return;
    }
    if (keymap?.kind === 'bytes') {
      const kmFields = pbDecode(keymap.value);
      const getKeymap = pbAsVarint(kmFields.find((f) => f.field === 1)?.value);
      if (getKeymap !== undefined) {
        if (!this.studioUnlocked) {
          this.options.onLog?.('warn', '[vkb:zmk-studio] get_keymap while locked -> UNLOCK_REQUIRED');
          send(zmkFrameEncode(encodeSimpleErrorResponse(requestId, 1))); // UNLOCK_REQUIRED
          return;
        }
        this.options.onLog?.('info', '[vkb:zmk-studio] get_keymap -> 2 layers');
        send(zmkFrameEncode(encodeKeymapResponse(requestId, 2, ['base', 'nav'])));
        return;
      }
    }
    send(zmkFrameEncode(encodeSimpleErrorResponse(requestId, 3)));
  }

  private runSimulator(transport: DeviceTransport): void {
    let buf = '';
    transport.setHandlers({
      onData: (b) => {
        const s = this.count(transport);
        s.bytesIn += b.length;
        s.writeCount += 1;
        buf += Buffer.from(b).toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          void this.handleSimLine(transport, line, s);
        }
      },
      onOpen: () => this.options.onLog?.('info', '[vkb:simulator] transport open'),
      onClose: () => {
        this.connected = false;
        this.options.onLog?.('warn', '[vkb:simulator] host disconnected');
      },
      onError: (e) => this.options.onLog?.('error', `[vkb:simulator] ${e.message}`),
    });
  }

  private async handleSimLine(transport: DeviceTransport, line: string, s: DeviceStats): Promise<void> {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'sim:hello') {
      const reply = JSON.stringify({ type: 'resp:sim:hello', role: 'simulator-keyboard', mode: this.options.mode }) + '\n';
      await transport.write(Uint8Array.from(Buffer.from(reply, 'utf8'))).catch(() => {});
      s.bytesOut += reply.length;
      this.options.onLog?.('info', '[vkb:simulator] sim:hello answered');
      return;
    }
    if (msg.type === 'sim:op') {
      const reply = JSON.stringify({ type: 'ack:sim:op', capability: msg.capability, ok: true }) + '\n';
      await transport.write(Uint8Array.from(Buffer.from(reply, 'utf8'))).catch(() => {});
      s.bytesOut += reply.length;
      this.options.onLog?.('info', `[vkb:simulator] op ${String(msg.capability)} acknowledged`);
      return;
    }
  }

  /** Programmatic key press (AKP mode only — used by CLI scenarios/tests). */
  async pressKey(key: string, tapCount = 1): Promise<boolean> {
    const session = [...this.sessions].pop();
    if (!session) return false;
    const action = this.resolveAction(key);
    this.options.onLog?.('info', `[vkb] key ${key} -> action ${action}`);
    return session.sendCmd({ action, source: key, ts: Date.now(), press_count: tapCount });
  }

  async knob(dir: 1 | -1): Promise<boolean> {
    const session = [...this.sessions].pop();
    if (!session) return false;
    return session.sendJson(0x0b as never, { dir, ts: Date.now() });
  }

  private resolveAction(key: string): 'select_agent' | 'approve' | 'reject' | 'new_task' | 'send' | 'dictate' | 'fast_mode' | 'reasoning_up' | 'reasoning_down' | 'custom' {
    const map: Record<string, 'select_agent' | 'approve' | 'reject' | 'new_task' | 'send' | 'dictate' | 'fast_mode' | 'reasoning_up' | 'reasoning_down'> = {
      F13: 'select_agent', F14: 'approve', F15: 'reject', F16: 'new_task',
      F17: 'send', F18: 'dictate', F19: 'fast_mode', F20: 'reasoning_up',
      F21: 'reasoning_down',
    };
    return map[key] ?? 'custom';
  }
}
