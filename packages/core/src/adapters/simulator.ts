/**
 * Simulator adapter (round-15). Talks to the TCP virtual keyboard simulator
 * using a simple JSON line protocol (framed by the TCP transport). Simulator
 * results NEVER substitute for real protocol verification — the simulator
 * profile is explicitly marked verified-simulator only.
 */

import type { CapabilityId, CapabilityOp } from '../capabilities/model';
import type { AdapterContext, IdentifyResult, OpResult, ProtocolAdapter } from './types';

export const SIMULATOR_ADAPTER_ID = 'simulator';

export interface SimulatorDeviceMessage {
  type: string;
  [k: string]: unknown;
}

export class SimulatorAdapter implements ProtocolAdapter {
  readonly id = SIMULATOR_ADAPTER_ID;
  readonly profileId = 'simulator';
  static readonly implementedCapabilities: CapabilityId[] = [
    'read-key-event', 'read-encoder-event', 'set-indicator', 'set-rgb',
    'set-rgb-matrix', 'set-backlight', 'display-text', 'display-icon',
    'haptic', 'runtime-keymap', 'approval-input', 'profile-switch',
  ];

  private attached = false;
  private inbox: Uint8Array[] = [];
  private waiters: Array<{ match: (m: SimulatorDeviceMessage) => boolean; resolve: (m: SimulatorDeviceMessage | null) => void; timer: NodeJS.Timeout }> = [];
  private parser: SimJsonParser = new SimJsonParser();

  attach(ctx: AdapterContext): void {
    if (this.attached) return;
    this.attached = true;
    this.parser.reset();
    ctx.transport.setHandlers({
      onData: (b) => {
        for (const msg of this.parser.push(b)) this.onMessage(msg);
      },
      onOpen: () => {},
      onClose: () => {
        for (const w of this.waiters) {
          clearTimeout(w.timer);
          w.resolve(null);
        }
        this.waiters = [];
      },
      onError: (e) => ctx.onLog('error', `[simulator] transport error: ${e.message}`),
    });
  }

  private onMessage(msg: SimulatorDeviceMessage): void {
    const idx = this.waiters.findIndex((w) => w.match(msg));
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      this.inbox.push(Uint8Array.from(Buffer.from(JSON.stringify(msg), 'utf8')));
    }
  }

  async identify(ctx: AdapterContext): Promise<IdentifyResult> {
    this.attach(ctx);
    const hello = await this.request(ctx, { type: 'sim:hello' }, 1500);
    if (!hello || (hello as { role?: string }).role !== 'simulator-keyboard') {
      ctx.onLog('warn', '[simulator] no simulator keyboard handshake');
      return { status: 'unknown', capabilities: { ...ctx.profile.capabilities }, error: 'no simulator keyboard response' };
    }
    ctx.onLog('info', '[simulator] simulator keyboard identified');
    return { status: 'identified', capabilities: { ...ctx.profile.capabilities } };
  }

  request(ctx: AdapterContext, msg: SimulatorDeviceMessage, timeoutMs: number): Promise<SimulatorDeviceMessage | null> {
    this.attach(ctx);
    const type = msg.type;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.match.length === 0);
        void idx;
        resolve(null);
      }, timeoutMs);
      const waiter = {
        match: (m: SimulatorDeviceMessage) => m.type === `ack:${type}` || m.type === `resp:${type}`,
        resolve,
        timer,
      };
      this.waiters.push(waiter);
      void ctx.transport.write(Uint8Array.from(Buffer.from(JSON.stringify(msg) + '\n', 'utf8'))).catch((err) => {
        const idx2 = this.waiters.indexOf(waiter);
        if (idx2 >= 0) this.waiters.splice(idx2, 1);
        clearTimeout(timer);
        resolve(null);
        ctx.onLog('error', `[simulator] write failed: ${(err as Error).message}`);
      });
    });
  }

  async apply(op: CapabilityOp, ctx: AdapterContext): Promise<OpResult> {
    this.attach(ctx);
    const payload = { capability: op.kind, payload: op.payload };
    const msg: SimulatorDeviceMessage = { type: 'sim:op', ...payload };
    const bytes = Uint8Array.from(Buffer.from(JSON.stringify(msg) + '\n', 'utf8'));
    await ctx.transport.write(bytes);
    ctx.onLog('info', `[simulator] op ${op.kind} -> simulator keyboard`);
    return { ok: true, wrote: true, bytes: bytes.length };
  }

  async close(): Promise<void> {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    this.inbox = [];
    this.attached = false;
  }
}

/** Line-oriented JSON parser (messages separated by \n). */
export class SimJsonParser {
  private buf = '';

  push(bytes: Uint8Array): SimulatorDeviceMessage[] {
    this.buf += Buffer.from(bytes).toString('utf8');
    const out: SimulatorDeviceMessage[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SimulatorDeviceMessage);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  }

  reset(): void {
    this.buf = '';
  }
}
