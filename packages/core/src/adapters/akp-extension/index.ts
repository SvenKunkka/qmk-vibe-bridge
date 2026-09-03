/**
 * AKP Extension adapter (round-15). The previously "global" custom protocol
 * (AKP v1) is now an OPTIONAL extension adapter, migrated here from the old
 * global state machine. Nothing about AKP gates any other device: a device
 * that does not send an AKP HELLO is simply "protocol unknown" and stays
 * read-only — it is NEVER called "firmware incompatible".
 *
 * Identification is the protocol's own handshake: the host opens the exact
 * Raw HID interface and listens for a device-initiated HELLO (zero writes
 * during identification). Only after HELLO is received does the host reply
 * CAPS (the handshake completion) and permit gated ops.
 */

import { AgentState, colorForState, type CapsPayload, type CmdPayload, type HelloPayload, type RGB } from '@vibebridge/akp-codec';
import type { CapabilityId, CapabilityOp } from '../../capabilities/model';
import type { AdapterContext, IdentifyResult, OpResult, ProtocolAdapter } from '../types';
import { AkpSession } from './session';
import { QMK_RAW_HID_REPORT_SIZE } from '../../profiles/builtin';

export const AKP_EXTENSION_ADAPTER_ID = 'akp-extension';

export interface AkpExtensionAdapterOptions {
  handshakeTimeoutMs?: number;
  heartbeatMs?: number;
}

export class AkpExtensionAdapter implements ProtocolAdapter {
  readonly id = AKP_EXTENSION_ADAPTER_ID;
  readonly profileId = 'akp-extension';
  /** capabilities with a real handler (writes via session; reads via onCmd/onEncoder) */
  static readonly implementedCapabilities: CapabilityId[] = [
    'read-key-event', 'read-encoder-event', 'set-indicator', 'set-rgb',
    'set-rgb-matrix', 'display-text', 'approval-input',
  ];

  private readonly handshakeTimeoutMs: number;
  private readonly heartbeatMs: number;
  private session: AkpSession | null = null;
  private hello: HelloPayload | null = null;

  constructor(opts: AkpExtensionAdapterOptions = {}) {
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5000;
    this.heartbeatMs = opts.heartbeatMs ?? 1500;
  }

  get isReady(): boolean {
    return this.hello !== null && !!this.session?.isAkpReady;
  }

  get lastHello(): HelloPayload | null {
    return this.hello;
  }

  /** Open the transport and wait for the device-initiated AKP HELLO. */
  async identify(ctx: AdapterContext): Promise<IdentifyResult> {
    const caps = ctx.profile.capabilities;
    if (this.session) {
      await this.session.stop();
      this.session = null;
      this.hello = null;
    }
    const session = new AkpSession(ctx.transport, {
      role: 'host',
      mtu: QMK_RAW_HID_REPORT_SIZE,
      heartbeatMs: this.heartbeatMs,
      onLog: (l, m) => ctx.onLog(l, `[akp-extension] ${m}`),
    });
    this.session = session;

    const helloPromise = new Promise<HelloPayload | null>((resolve) => {
      session.on('onHello', (hello) => resolve(hello));
    });

    try {
      await session.start();
    } catch (err) {
      ctx.onLog('warn', `[akp-extension] transport open failed: ${(err as Error).message}`);
      return { status: 'unknown', capabilities: { ...caps }, error: (err as Error).message };
    }

    const hello = await Promise.race([
      helloPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), this.handshakeTimeoutMs)),
    ]);

    if (!hello) {
      ctx.onLog('warn', '[akp-extension] no AKP HELLO within handshake window — protocol unknown, device stays read-only');
      void session.stop().catch(() => {});
      this.session = null;
      return {
        status: 'unknown',
        capabilities: { ...caps },
        error: 'no AKP HELLO within window (device does not speak AKP — treated as protocol unknown, read-only)',
      };
    }

    this.hello = hello;
    ctx.onLog('info', `[akp-extension] identified (fw=${hello.fw ?? '?'} v${hello.fw_version ?? '?'})`);
    // handshake completion: reply CAPS (protocol-defined write, post-identification)
    const capsReply: CapsPayload = {
      proto: 1,
      features: hello.features ?? [],
      rgb: { per_key: true, led_count: hello.led_count ?? 0, rgbw: hello.rgbw ?? false, brightness: 60 },
      oled: { lines: hello.oled_lines ?? 4, enabled: (hello.features ?? []).includes('oled') },
      status_led: { enabled: (hello.features ?? []).includes('status_led') },
      encoder: { enabled: (hello.features ?? []).includes('encoder') },
      mtu: QMK_RAW_HID_REPORT_SIZE,
    };
    await session.sendCaps(capsReply);
    return {
      status: 'identified',
      capabilities: { ...caps },
      observedVersion: hello.fw_version,
    };
  }

  /** Incoming keyboard commands (approval-input etc.) are surfaced via onCmd. */
  onCmd(cb: (cmd: CmdPayload) => void): void {
    this.session?.on('onCmd', (cmd) => cb(cmd));
  }

  async apply(op: CapabilityOp, ctx: AdapterContext): Promise<OpResult> {
    if (!this.session || !this.hello) {
      return { ok: false, error: 'AKP session not identified', wrote: false };
    }
    switch (op.kind) {
      case 'set-indicator': {
        const color = (op.payload as { color: RGB }).color;
        const ok = await this.session.sendState({
          state: AgentState.IDLE, // indicator only — no state change
          color,
          agent: 'vibebridge',
        });
        return { ok, wrote: ok, bytes: 32, error: ok ? undefined : 'AKP write failed' };
      }
      case 'set-rgb':
      case 'set-rgb-matrix': {
        const p = op.payload as { mode?: string; color?: RGB; brightness?: number };
        const ok = await this.session.sendRgb({
          mode: p.mode ?? 'solid',
          color: p.color ?? { r: 255, g: 255, b: 255 },
          brightness: p.brightness ?? 60,
        });
        return { ok, wrote: ok, error: ok ? undefined : 'AKP write failed' };
      }
      case 'display-text': {
        const p = op.payload as { text: string; title?: string };
        const ok = await this.session.sendScreen({ lines: wrapLines(p.text), title: p.title });
        return { ok, wrote: ok, error: ok ? undefined : 'AKP write failed' };
      }
      default:
        return { ok: false, error: `AKP adapter does not implement capability "${op.kind}"`, wrote: false };
    }
  }

  async close(): Promise<void> {
    if (this.session) {
      await this.session.stop();
      this.session = null;
      this.hello = null;
    }
  }
}

function wrapLines(text: string): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (cur.length >= 21) {
      lines.push(cur);
      cur = '';
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}
