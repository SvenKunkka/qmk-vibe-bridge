/**
 * AkpSession — full-duplex AKP session over a DeviceTransport.
 *
 * Host role: receives HELLO from the keyboard, replies CAPS, sends STATE/RGB/
 * SCREEN/ACK/ERR, handles CMD/ENCODER/KEYEVENT/HEARTBEAT.
 * Device role: sends HELLO, awaits CAPS, sends CMD/ENCODER, handles STATE/RGB/SCREEN.
 */

import {
  AgentState, MsgType, MTU_DEFAULT, ackRequested, buildAck, buildCaps, buildErr, buildHello,
  buildHeartbeat, buildRgbPerKey, decodeFrame, decodeMessage, encodeMessage, frameMessage,
  jsonOf, parseAck, parseCaps, parseCmd, parseEncoder, parseHeartbeat,
  parseHello, parseKeyEvent, type AkpMessage, type CapsPayload, type CmdPayload,
  type EncoderPayload, type HeartbeatPayload, type HelloPayload, type KeyEventPayload,
  type StatePayload,
} from '@vibebridge/akp-codec';
import type { DeviceTransport } from '../../transports/types';

export interface SessionOptions {
  role: 'host' | 'device';
  mtu?: number;
  heartbeatMs?: number;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export interface SessionHandlers {
  onHello?(p: HelloPayload): void;
  onCaps?(p: CapsPayload): void;
  onCmd?(p: CmdPayload): void;
  onEncoder?(p: EncoderPayload): void;
  onKeyEvent?(p: KeyEventPayload): void;
  onState?(p: StatePayload): void;
  onHeartbeat?(p: HeartbeatPayload): void;
  onRgb?(p: unknown, raw: Uint8Array): void;
  onScreen?(p: { lines: string[]; title?: string; bar?: { value: number; max: number }; clear?: boolean }): void;
  onAck?(p: { ok: boolean; ack_seq: number; error?: string }): void;
  onErr?(p: { code: string; msg?: string }): void;
  onDisconnected?(err?: Error): void;
}

export class AkpSession {
  readonly role: 'host' | 'device';
  readonly mtu: number;
  private readonly transport: DeviceTransport;
  private seq = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAt = 0;
  private connected = false;
  private readonly handlers: SessionHandlers = {};
  private readonly onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private readonly heartbeatMs: number;
  private closed = false;
  private sendChain: Promise<unknown> = Promise.resolve();
  /**
   * Round-13: AKP handshake gate. The transport may be open, but a HOST must
   * not consider the device AKP-connected (and must not WRITE anything) until
   * a valid, decodable HELLO has been received. This prevents blind writes to
   * vendor-private Raw HID interfaces (e.g. usagePage 0xFFC1) and false
   * "connected" states.
   */
  private akpReady = false;

  constructor(transport: DeviceTransport, opts: SessionOptions) {
    this.transport = transport;
    this.role = opts.role;
    this.mtu = opts.mtu ?? MTU_DEFAULT;
    this.heartbeatMs = opts.heartbeatMs ?? 1500;
    this.onLog = opts.onLog ?? (() => {});
    transport.setHandlers({
      onData: (r: Uint8Array) => this.onReport(r),
      onOpen: () => this.onOpen(),
      onClose: (err?: Error) => this.onClose(err),
      onError: (err: Error) => this.onError(err),
    });
  }

  on<K extends keyof SessionHandlers>(kind: K, fn: SessionHandlers[K]): void {
    (this.handlers as Record<string, unknown>)[kind] = fn;
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /** Start the session (open transport + begin handshake). */
  async start(): Promise<void> {
    this.closed = false;
    this.akpReady = false;
    await this.transport.open();
    if (this.role === 'device') {
      this.sendHello();
      this.startHeartbeat();
    }
    // host: heartbeat (and any write) starts only after a valid HELLO — until
    // then the session is "handshake pending" and send() is a no-op (round 13)
  }

  /** True once a valid AKP HELLO was received (host) / sent (device). */
  get isAkpReady(): boolean {
    return this.akpReady;
  }

  private onOpen(): void {
    this.connected = true;
    this.lastHeartbeatAt = Date.now();
  }

  private onClose(err?: Error): void {
    if (this.closed) return;
    this.connected = false;
    this.stopHeartbeat();
    this.handlers.onDisconnected?.(err);
  }

  private onError(err: Error): void {
    this.onLog('error', `transport error: ${err.message}`);
  }

  private onReport(report: Uint8Array): void {
    try {
      for (const msgBytes of this.assembler.push(report)) {
        this.dispatch(msgBytes);
      }
    } catch (err) {
      this.onLog('warn', `bad frame: ${(err as Error).message}`);
    }
  }

  private assembler: { push(bytes: Uint8Array): Uint8Array[]; reset(): void } = (() => {
    let chunks: Uint8Array[] = [];
    let expectedIndex = 0;
    let started = false;
    let bytes = 0;
    const maxMessage = 0xffff;
    return {
      push(frameBytes: Uint8Array) {
        const frame = decodeFrame(frameBytes);
        if (!frame) return [];
        const out: Uint8Array[] = [];
        if (!started) {
          started = true;
          expectedIndex = frame.index;
          chunks = [];
          bytes = 0;
        }
        if (frame.index !== expectedIndex) {
          started = false;
          chunks = [];
          bytes = 0;
          return out;
        }
        chunks.push(frame.data);
        bytes += frame.data.length;
        if (bytes > maxMessage) {
          started = false;
          chunks = [];
          bytes = 0;
          return out;
        }
        expectedIndex = (expectedIndex + 1) & 0x0f;
        if (!frame.more) {
          const size = chunks.reduce((a, c) => a + c.length, 0);
          const merged = new Uint8Array(size);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
          }
          started = false;
          chunks = [];
          bytes = 0;
          out.push(merged);
        }
        return out;
      },
      reset() {
        started = false;
        chunks = [];
        bytes = 0;
      },
    };
  })();

  private dispatch(msgBytes: Uint8Array): void {
    let msg: AkpMessage;
    try {
      const r = decodeMessage(msgBytes);
      if (r.consumed === 0) return;
      msg = r.message;
    } catch (err) {
      this.onLog('warn', `bad message: ${(err as Error).message}`);
      return;
    }
    switch (msg.type) {
      case MsgType.HELLO: {
        const hello = parseHello(msg);
        this.akpReady = true; // a decodable AKP HELLO proves the device speaks AKP
        this.handlers.onHello?.(hello);
        if (this.role === 'host') {
          this.startHeartbeat(); // host heartbeat begins only after handshake
          // host replies with negotiated capabilities
          void this.sendCaps({
            proto: 1,
            features: hello.features ?? [],
            rgb: { per_key: true, led_count: hello.led_count ?? 0, rgbw: hello.rgbw ?? false, brightness: 60 },
            oled: { lines: hello.oled_lines ?? 4, enabled: (hello.features ?? []).includes('oled') },
            status_led: { enabled: (hello.features ?? []).includes('status_led') },
            encoder: { enabled: (hello.features ?? []).includes('encoder') },
            mtu: this.mtu,
          });
        }
        break;
      }
      case MsgType.CAPS:
        this.handlers.onCaps?.(parseCaps(msg));
        break;
      case MsgType.HEARTBEAT: {
        const p = parseHeartbeat(msg);
        this.lastHeartbeatAt = Date.now();
        this.handlers.onHeartbeat?.(p);
        break;
      }
      case MsgType.CMD: {
        const p = parseCmd(msg);
        this.handlers.onCmd?.(p);
        if (ackRequested(msg)) {
          void this.sendAck(msg.seq, true);
        }
        break;
      }
      case MsgType.ENCODER:
        this.handlers.onEncoder?.(parseEncoder(msg));
        break;
      case MsgType.KEYEVENT:
        this.handlers.onKeyEvent?.(parseKeyEvent(msg));
        break;
      case MsgType.STATE:
        this.handlers.onState?.(jsonOf<StatePayload>(msg) ?? { state: AgentState.IDLE });
        break;
      case MsgType.RGB:
        this.handlers.onRgb?.(jsonOf(msg), msg.payload);
        break;
      case MsgType.SCREEN:
        this.handlers.onScreen?.(jsonOf(msg) ?? { lines: [] });
        break;
      case MsgType.ACK:
        this.handlers.onAck?.(jsonOf(msg) ?? { ok: false, ack_seq: 0 });
        break;
      case MsgType.ERR:
        this.handlers.onErr?.(jsonOf(msg) ?? { code: 'unknown' });
        break;
      case MsgType.DICTATE:
        this.onLog('info', 'dictation status update received');
        break;
      default:
        this.onLog('warn', `unhandled message type ${msg.type}`);
    }
  }

  /** Send a raw encoded message. */
  async send(bytes: Uint8Array, opts?: { ackRequested?: boolean }): Promise<boolean> {
    // after stop() or a transport close, sends are no-ops — no queued heartbeat
    // or state push may hit a dead socket or log a spurious error (P1 fix)
    if (this.closed || !this.connected) return false;
    // round-13: a HOST never writes before a valid AKP HELLO (STATE/RGB/SCREEN/
    // CAPS/HEARTBEAT must not be sent to unknown vendor-private HID interfaces)
    if (this.role === 'host' && !this.akpReady) return false;
    if (opts?.ackRequested) {
      // patch the ack-requested flag into the encoded message
      bytes[3] = (bytes[3] ?? 0) | 0x01;
    }
    const run = async (): Promise<boolean> => {
      if (this.closed) return false;
      try {
        for (const frame of frameMessage(bytes, this.mtu)) {
          await this.transport.write(frame.bytes);
        }
        return true;
      } catch (err) {
        // a transport closed mid-flight during shutdown is expected, not an error
        if (!this.closed) this.onLog('error', `send failed: ${(err as Error).message}`);
        return false;
      }
    };
    // serialize: a fragmented message must not interleave with other sends
    const result = this.sendChain.then(run);
    this.sendChain = result.catch(() => {});
    return result;
  }

  async sendJson(type: MsgType, obj: object, opts?: { ackRequested?: boolean }): Promise<boolean> {
    return this.send(encodeMessage(type, JSON.stringify(obj), this.nextSeq(), opts), opts);
  }

  sendHello(hello?: HelloPayload): Promise<boolean> {
    const p: HelloPayload = hello ?? { proto: 1, fw: 'virtual', fw_version: '0.9.0', features: ['raw_hid', 'f13_f24', 'encoder', 'rgb_matrix', 'rgb_light', 'oled', 'status_led'] };
    return this.send(buildHello(p, this.nextSeq()));
  }

  sendCaps(caps: CapsPayload): Promise<boolean> {
    return this.send(buildCaps(caps, this.nextSeq()));
  }

  sendState(state: StatePayload): Promise<boolean> {
    return this.sendJson(MsgType.STATE, state);
  }

  sendRgb(payload: object | Uint8Array): Promise<boolean> {
    return this.send(encodeMessage(MsgType.RGB, payload as never, this.nextSeq()));
  }

  /**
   * Send per-key RGB as a proper AKP RGB message.
   * The binary payload ([flags, led_count u16 LE, rgb per led]) MUST be wrapped
   * in a message via buildRgbPerKey() — sending the raw payload used to
   * produce frame/message misalignment on the receiving side (P0 fix).
   */
  sendRgbPerKey(leds: Array<{ r: number; g: number; b: number } | [number, number, number, number]>): Promise<boolean> {
    return this.send(buildRgbPerKey(leds, this.nextSeq()));
  }

  sendScreen(payload: { lines: string[]; title?: string; bar?: { value: number; max: number }; clear?: boolean }): Promise<boolean> {
    return this.sendJson(MsgType.SCREEN, payload);
  }

  sendAck(ackSeq: number, ok: boolean, error?: string): Promise<boolean> {
    return this.send(buildAck(ackSeq, ok, error, this.nextSeq()));
  }

  sendErr(code: string, msg?: string): Promise<boolean> {
    return this.send(buildErr(code, msg, this.nextSeq()));
  }

  sendCmd(cmd: CmdPayload): Promise<boolean> {
    return this.sendJson(MsgType.CMD, cmd);
  }

  sendHeartbeat(payload: HeartbeatPayload): Promise<boolean> {
    return this.send(buildHeartbeat(payload, this.nextSeq()));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.connected && !this.closed) {
        void this.sendHeartbeat({ t: Math.floor(Date.now() / 1000), state: AgentState.IDLE });
      }
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get lastHeartbeat(): number {
    return this.lastHeartbeatAt;
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();
    await this.transport.close();
  }
}
