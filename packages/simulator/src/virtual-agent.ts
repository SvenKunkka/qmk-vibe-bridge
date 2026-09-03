/**
 * VirtualAgentServer — a simulated AI agent with an authoritative state
 * machine. The desktop app connects over TCP (JSON lines) via the
 * VirtualAgentBridge. The simulator emits exact states and reacts to keyboard
 * actions, so the bidirectional loop is fully demonstrable without hardware.
 *
 * State machine:
 *   idle --(user prompt)--> thinking --(tool call)--> tool --(done)--> done --(idle after pause)--> idle
 *   tool --(needs approval)--> waiting --(approve)--> tool ; --(reject)--> done(error)
 */

import * as net from 'node:net';
import { AgentState } from '@vibebridge/akp-codec';
import type { ActionName } from '@vibebridge/akp-codec';

export interface VirtualAgentOptions {
  host?: string;
  port?: number;
  /** milliseconds per step */
  thinkingMs?: number;
  toolMs?: number;
  idleMs?: number;
  /** when true, cycles are automatic; when false, waits for prompts */
  auto?: boolean;
  /** delay before the next step after a completed step */
  continueMs?: number;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  onState?: (state: AgentState, text?: string) => void;
  onAction?: (action: ActionName) => void;
}

export interface WireEvent {
  type: 'state';
  state: AgentState;
  text?: string;
  step?: string;
  session?: string;
  progress?: number;
  ts: number;
}

export class VirtualAgentServer {
  readonly options: VirtualAgentOptions;
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private state: AgentState = AgentState.IDLE;
  private timer: NodeJS.Timeout | null = null;
  private cycle = 0;
  private stepIndex = 0;
  private sessionId = `sim-${Date.now().toString(36)}`;

  constructor(options: VirtualAgentOptions = {}) {
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 18903,
      thinkingMs: options.thinkingMs ?? 1200,
      toolMs: options.toolMs ?? 900,
      idleMs: options.idleMs ?? 2500,
      continueMs: options.continueMs ?? 600,
      auto: options.auto ?? true,
      onLog: options.onLog ?? (() => {}),
      onState: options.onState,
      onAction: options.onAction,
    };
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setEncoding('utf8');
        this.sockets.add(socket);
        this.options.onLog?.('info', '[vag] app connected');
        socket.on('data', (chunk: string) => this.handleData(socket, chunk));
        socket.on('error', () => {});
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('end', () => this.sockets.delete(socket));
        // send current state immediately on connect
        this.broadcast();
      });
      this.server = server;
      server.on('error', reject);
      server.listen(this.options.port!, this.options.host!, () => {
        const addr = server.address() as net.AddressInfo;
        this.options.onLog?.('info', `[vag] virtual agent listening on ${this.options.host}:${addr.port}`);
        if (this.options.auto) {
          this.scheduleCycle();
        }
        resolve(addr.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      (this.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    this.server = null;
  }

  getState(): AgentState {
    return this.state;
  }

  private handleData(socket: net.Socket, chunk: string): void {
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: { type?: string; action?: ActionName; ts?: number };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === 'action' && msg.action) {
        this.options.onAction?.(msg.action);
        this.handleAction(msg.action);
      }
    }
  }

  /** Simulated keyboard/UI actions drive the state machine. */
  handleAction(action: ActionName): void {
    this.options.onLog?.('info', `[vag] action received: ${action}`);
    switch (action) {
      case 'approve':
        if (this.state === AgentState.WAITING) {
          this.setState(AgentState.TOOL, 'approved, running tool…', 0.6);
          this.schedule(() => this.finishStep(), this.options.toolMs!);
        }
        break;
      case 'reject':
        if (this.state === AgentState.WAITING) {
          this.setState(AgentState.DONE, 'rejected', 1);
          this.schedule(() => this.toIdle(), this.options.idleMs!);
        }
        break;
      case 'cancel':
      case 'interrupt':
        this.setState(AgentState.DONE, 'interrupted', 1);
        this.schedule(() => this.toIdle(), this.options.idleMs!);
        break;
      case 'pause':
        if (this.timer) clearTimeout(this.timer);
        this.setState(AgentState.IDLE, 'paused', 0);
        break;
      case 'resume':
        this.scheduleCycle();
        break;
      case 'new_task':
        this.cycle = 0;
        this.setState(AgentState.THINKING, 'new task received…', 0.1);
        this.schedule(() => this.runToolStep(), this.options.thinkingMs!);
        break;
      case 'fast_mode':
        this.options.onLog?.('info', '[vag] fast mode toggled (simulated)');
        break;
      case 'reasoning_up':
      case 'reasoning_down':
        this.options.onLog?.('info', `[vag] reasoning depth adjusted (${action})`);
        break;
      case 'send':
        this.options.onLog?.('info', '[vag] send pressed');
        break;
      case 'dictate':
        this.setState(AgentState.DICTATING, 'dictating…', 0);
        this.schedule(() => this.setState(AgentState.THINKING, 'dictated text received', 0.2), 1500);
        this.schedule(() => this.runToolStep(), 2500);
        break;
      case 'select_agent':
        this.options.onLog?.('info', '[vag] agent selected (simulated)');
        break;
      default:
        break;
    }
  }

  private scheduleCycle(): void {
    this.schedule(() => {
      this.cycle += 1;
      this.stepIndex = 0;
      this.setState(AgentState.THINKING, `thinking… (cycle ${this.cycle})`, 0.15);
      this.schedule(() => this.runToolStep(), this.options.thinkingMs!);
    }, 800);
  }

  private runToolStep(): void {
    this.stepIndex += 1;
    // every 3rd step asks for approval to exercise the approve/reject path
    if (this.stepIndex % 3 === 0) {
      this.setState(AgentState.WAITING, `step ${this.stepIndex}: needs approval`, 0.8);
      return; // wait for approve/reject
    }
    this.setState(AgentState.TOOL, `running tool ${this.stepIndex}…`, 0.5);
    this.schedule(() => this.finishStep(), this.options.toolMs!);
  }

  private finishStep(): void {
    if (this.state === AgentState.ERROR) return;
    if (this.stepIndex >= 4) {
      this.setState(AgentState.DONE, `all steps complete (cycle ${this.cycle})`, 1);
      this.schedule(() => this.toIdle(), this.options.idleMs!);
      return;
    }
    this.setState(AgentState.THINKING, `step ${this.stepIndex} done, continuing…`, 0.4);
    this.schedule(() => this.runToolStep(), this.options.continueMs!);
  }

  private toIdle(): void {
    if (this.options.auto) {
      this.setState(AgentState.IDLE, 'idle', 0);
      this.scheduleCycle();
    } else {
      this.setState(AgentState.IDLE, 'idle', 0);
    }
  }

  private setState(state: AgentState, text?: string, progress?: number): void {
    this.state = state;
    const ev: WireEvent = {
      type: 'state',
      state,
      text,
      step: state === AgentState.TOOL ? `tool step` : undefined,
      session: this.sessionId,
      progress,
      ts: Date.now(),
    };
    this.options.onLog?.('info', `[vag] state -> ${state} ${text ?? ''}`);
    this.options.onState?.(state, text);
    this.broadcast(ev);
  }

  private broadcast(ev?: WireEvent): void {
    const payload: WireEvent =
      ev ?? {
        type: 'state',
        state: this.state,
        text: 'idle',
        session: this.sessionId,
        ts: Date.now(),
      };
    const line = JSON.stringify(payload) + '\n';
    for (const s of this.sockets) {
      if (!s.destroyed) s.write(line);
    }
  }

  private schedule(fn: () => void, ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(fn, ms);
  }
}
