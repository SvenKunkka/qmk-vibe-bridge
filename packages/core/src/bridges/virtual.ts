/**
 * Virtual agent bridge — connects to the virtual agent simulator over TCP
 * (JSON lines). The simulator owns the authoritative state machine, so this
 * bridge yields exact states (confidence 1.0) and can also forward keyboard
 * actions back to the simulator, demonstrating the full bidirectional loop.
 */

import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { AgentBridge, type AgentSnapshot } from '../agent-bridge';
import { AgentState, colorForState } from '@vibebridge/akp-codec';
import type { ActionName } from '@vibebridge/akp-codec';

export interface VirtualAgentWireEvent {
  type: 'state';
  state: AgentState;
  text?: string;
  step?: string;
  session?: string;
  progress?: number;
  ts?: number;
}

export interface VirtualAgentBridgeOptions {
  host?: string;
  port?: number;
  reconnectMs?: number;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class VirtualAgentBridge extends AgentBridge {
  readonly id = 'virtual';
  readonly label = 'Virtual Agent';
  private socket: net.Socket | null = null;
  private snapshot: AgentSnapshot | undefined;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly opts: VirtualAgentBridgeOptions;
  private buffer = '';
  private stopped = false;
  private lastReconnectLoggedAt = 0;

  /** actions the simulator can consume */
  static readonly SUPPORTED_ACTIONS: ActionName[] = [
    'approve', 'reject', 'new_task', 'send', 'cancel', 'interrupt', 'pause', 'resume',
    'fast_mode', 'reasoning_up', 'reasoning_down', 'select_agent', 'dictate', 'custom',
  ];

  constructor(opts: VirtualAgentBridgeOptions = {}) {
    super();
    this.opts = opts;
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 18903;
  }

  getSnapshot(): AgentSnapshot | undefined {
    return this.snapshot;
  }

  override start(): void {
    super.start();
    this.stopped = false;
    void this.connect();
  }

  override stop(): void {
    super.stop();
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  /** Forward a keyboard action to the simulator (best effort). */
  sendAction(action: ActionName | string, extra?: Record<string, unknown>): boolean {
    const s = this.socket;
    if (!s || s.destroyed) return false;
    const line = JSON.stringify({ type: 'action', action, ts: Date.now(), ...extra });
    s.write(line + '\n');
    return true;
  }

  private connect(): void {
    if (this.stopped || !this.isEnabled) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.opts.onLog?.('info', `[virtual] connected to ${this.host}:${this.port}`);
      this.emit('connected');
    });
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
    socket.on('error', (err) => {
      this.opts.onLog?.('warn', `[virtual] socket error: ${err.message}`);
    });
    socket.on('close', () => {
      this.socket = null;
      if (this.stopped || !this.isEnabled) return;
      // dedupe: only log the reconnect attempt at most once per 5s so the UI
      // status line is not flooded with identical lines (round-5 fix)
      const now = Date.now();
      if (now - this.lastReconnectLoggedAt > 5000) {
        this.lastReconnectLoggedAt = now;
        this.opts.onLog?.('warn', '[virtual] disconnected, reconnecting…');
      }
      this.reconnectTimer = setTimeout(() => this.connect(), this.opts.reconnectMs ?? 2000);
    });
  }

  private handleLine(line: string): void {
    let ev: VirtualAgentWireEvent;
    try {
      ev = JSON.parse(line) as VirtualAgentWireEvent;
    } catch {
      return;
    }
    if (ev.type !== 'state') return;
    this.snapshot = {
      state: ev.state,
      agent: this.label,
      agentId: 'virtual',
      session: ev.session ?? 'sim',
      text: ev.text,
      step: ev.step,
      progress: ev.progress,
      color: colorForState(ev.state),
      ts: ev.ts ?? Date.now(),
      source: this.id,
      confidence: 1.0,
    };
    this.emit('snapshot', this.snapshot);
  }
}

export { EventEmitter };
