/**
 * AgentBridge — a source of agent status. Real tools are watched by tailing
 * their session logs (heuristic but configurable); the virtual agent gives
 * exact, bidirectional status for simulator-driven demos and tests.
 */

import { AgentState, type RGB } from '@vibebridge/akp-codec';
import { EventEmitter } from 'node:events';

export interface AgentSnapshot {
  state: AgentState;
  agent?: string; // display name
  agentId?: string;
  session?: string;
  /** workspace root name the session belongs to (e.g. DSH workspace dir) */
  workspace?: string;
  text?: string;
  step?: string;
  progress?: number; // 0..1
  color?: RGB;
  ts: number; // epoch ms
  source: string; // bridge id
  /** confidence 0..1 that the heuristic state is right */
  confidence: number;
}

export type AgentEvent =
  | { type: 'snapshot'; snapshot: AgentSnapshot }
  | { type: 'activity'; snapshot: AgentSnapshot };

export abstract class AgentBridge extends EventEmitter {
  abstract readonly id: string;
  abstract readonly label: string;
  protected enabled = false;

  start(): void {
    this.enabled = true;
  }
  stop(): void {
    this.enabled = false;
  }
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Latest snapshot (undefined until first observation). */
  abstract getSnapshot(): AgentSnapshot | undefined;

  protected emitSnapshot(s: AgentSnapshot): void {
    this.emit('snapshot', s);
  }
}
