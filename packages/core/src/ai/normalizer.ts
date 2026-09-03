/**
 * AI Event Normalizer (round-15). Converts raw observations from tool
 * providers (log heuristics, simulator wires) into the canonical AiEvent
 * vocabulary. Also maps the legacy AgentState names used by older bridges.
 */

import type { AiEvent, AiEventType } from './types';

/** legacy AgentState -> canonical AiEventType */
export function normalizeEventType(state: string): AiEventType {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'thinking':
      return 'thinking';
    case 'tool':
    case 'tool-running':
      return 'tool-running';
    case 'waiting':
    case 'waiting-for-approval':
      return 'waiting-for-approval';
    case 'dictating':
    case 'waiting-for-user':
      return 'waiting-for-user';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'idle';
  }
}

export interface Observation {
  state: string;
  agent?: string;
  agentId?: string;
  session?: string;
  text?: string;
  step?: string;
  progress?: number;
  ts?: number;
  source: string;
  confidence: number;
  simulated?: boolean;
}

export function normalizeObservation(o: Observation): AiEvent {
  return {
    type: normalizeEventType(o.state),
    source: o.source,
    agent: o.agent,
    agentId: o.agentId,
    session: o.session,
    text: o.text,
    step: o.step,
    progress: o.progress,
    ts: o.ts ?? Date.now(),
    confidence: o.confidence,
    simulated: o.simulated ?? false,
  };
}
