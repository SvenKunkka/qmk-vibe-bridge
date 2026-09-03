/**
 * Simulator AI Provider (round-15). Supplies AiEvents for the virtual agent —
 * either in-process (scripted sequence, used by tests and UI demo mode) or via
 * TCP to the standalone virtual-agent simulator. Events from this provider are
 * ALWAYS marked simulated=true and must never be presented as real agent
 * activity (round-15 rule).
 */

import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import type { AiEvent, AiEventProvider, AiEventType } from '../types';
import { normalizeEventType } from '../normalizer';

export interface SimulatorProviderOptions {
  /** TCP: connect to a running virtual-agent simulator (port 18903 default). */
  host?: string;
  port?: number;
  /** in-process scripted sequence (used when no TCP simulator is running) */
  scripted?: boolean;
  scriptIntervalMs?: number;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export const SIMULATOR_SCRIPT: AiEventType[] = [
  'idle',
  'thinking',
  'tool-running',
  'waiting-for-approval',
  'waiting-for-user',
  'done',
  'error',
  'idle',
];

export class SimulatorAiProvider extends EventEmitter implements AiEventProvider {
  readonly id = 'virtual';
  readonly label = 'Virtual Agent (simulator)';
  readonly simulated = true;

  private readonly opts: Required<SimulatorProviderOptions>;
  private latestEvent: AiEvent | undefined;
  private socket: net.Socket | null = null;
  private buffer = '';
  private stopped = false;
  private scriptTimer: NodeJS.Timeout | null = null;
  private scriptIdx = 0;

  constructor(opts: SimulatorProviderOptions = {}) {
    super();
    this.opts = {
      host: opts.host ?? '127.0.0.1',
      port: opts.port ?? 18903,
      scripted: opts.scripted ?? true,
      scriptIntervalMs: opts.scriptIntervalMs ?? 1200,
      onLog: opts.onLog ?? (() => {}),
    };
  }

  getLatest(): AiEvent | undefined {
    return this.latestEvent;
  }

  onEvent(cb: (ev: AiEvent) => void): () => void {
    this.on('event', cb);
    return () => this.off('event', cb);
  }

  start(): void {
    this.stopped = false;
    if (this.opts.scripted) {
      this.startScript();
    } else {
      this.connect();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.scriptTimer) clearInterval(this.scriptTimer);
    this.scriptTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  /** Emit a scripted event (also used by tests to drive the pipeline). */
  emitEvent(type: AiEventType, extra: Partial<AiEvent> = {}): AiEvent {
    const ev: AiEvent = {
      type,
      source: this.id,
      agent: this.label,
      agentId: 'virtual',
      session: 'sim',
      ts: Date.now(),
      confidence: 1.0,
      simulated: true,
      ...extra,
    };
    this.latestEvent = ev;
    this.emit('event', ev);
    return ev;
  }

  /** Forward an action (approve/reject/…) to the virtual-agent simulator. */
  sendAction(action: string, extra: Record<string, unknown> = {}): boolean {
    if (this.opts.scripted) {
      // in-process mode: acknowledge immediately
      this.emitEvent('idle', { text: `action ${action} acknowledged (scripted)` });
      return true;
    }
    const s = this.socket;
    if (!s || s.destroyed) return false;
    s.write(JSON.stringify({ type: 'action', action, ts: Date.now(), ...extra }) + '\n');
    return true;
  }

  private startScript(): void {
    if (this.scriptTimer) clearInterval(this.scriptTimer);
    const step = () => {
      if (this.stopped) return;
      const type = SIMULATOR_SCRIPT[this.scriptIdx % SIMULATOR_SCRIPT.length];
      this.scriptIdx += 1;
      this.emitEvent(type);
    };
    step();
    this.scriptTimer = setInterval(step, this.opts.scriptIntervalMs);
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => this.opts.onLog('info', `[virtual] connected to ${this.opts.host}:${this.opts.port}`));
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        this.handleLine(line);
      }
    });
    socket.on('error', (err) => this.opts.onLog('warn', `[virtual] socket error: ${err.message}`));
    socket.on('close', () => {
      this.socket = null;
      if (this.stopped) return;
      setTimeout(() => this.connect(), 2000);
    });
  }

  private handleLine(line: string): void {
    let ev: { type: string; state: string; text?: string; step?: string; session?: string; progress?: number; ts?: number };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      return;
    }
    if (ev.type !== 'state') return;
    const aiEvent: AiEvent = {
      type: normalizeEventType(ev.state),
      source: this.id,
      agent: this.label,
      agentId: 'virtual',
      session: ev.session ?? 'sim',
      text: ev.text,
      step: ev.step,
      progress: ev.progress,
      ts: ev.ts ?? Date.now(),
      confidence: 1.0,
      simulated: true,
    };
    this.latestEvent = aiEvent;
    this.emit('event', aiEvent);
  }
}
