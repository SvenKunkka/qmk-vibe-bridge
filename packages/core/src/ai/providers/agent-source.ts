/**
 * Agent-source providers (round-15): wrap the existing heuristic log-watchers
 * (DSH / Codex / Claude Code session logs) as AiEventProviders. These produce
 * REAL (simulated=false) events with a confidence score; they never pretend to
 * be exact.
 */

import { EventEmitter } from 'node:events';
import type { AiEvent, AiEventProvider } from '../types';
import { normalizeObservation } from '../normalizer';
import { DshBridge } from '../../bridges/dsh';
import { CodexBridge } from '../../bridges/codex';
import { ClaudeBridge } from '../../bridges/claude';

type LegacyBridge = { id: string; label: string; start(): void; stop(): void; getSnapshot(): unknown };

type LogFn = (level: 'info' | 'warn' | 'error', msg: string) => void;

function wrapLegacy(bridge: LegacyBridge, simulated: boolean, onLog?: LogFn): AiEventProvider {
  return {
    id: bridge.id,
    label: bridge.label,
    simulated,
    start: () => bridge.start(),
    stop: () => bridge.stop(),
    getLatest: () => {
      const snap = bridge.getSnapshot() as
        | { state: string; agent?: string; agentId?: string; session?: string; text?: string; step?: string; progress?: number; ts?: number; confidence?: number }
        | undefined;
      if (!snap) return undefined;
      return normalizeObservation({
        state: snap.state,
        agent: snap.agent,
        agentId: snap.agentId,
        session: snap.session,
        text: snap.text,
        step: snap.step,
        progress: snap.progress,
        ts: snap.ts,
        source: bridge.id,
        confidence: snap.confidence ?? 0.6,
        simulated,
      });
    },
    onEvent: (cb: (ev: AiEvent) => void) => {
      const emitter = bridge as unknown as EventEmitter;
      const handler = (snap: unknown) => {
        const s = snap as { state: string; agent?: string; agentId?: string; session?: string; text?: string; step?: string; progress?: number; ts?: number; confidence?: number };
        cb(
          normalizeObservation({
            state: s.state,
            agent: s.agent,
            agentId: s.agentId,
            session: s.session,
            text: s.text,
            step: s.step,
            progress: s.progress,
            ts: s.ts,
            source: bridge.id,
            confidence: s.confidence ?? 0.6,
            simulated,
          }),
        );
      };
      emitter.on('snapshot', handler);
      onLog?.('info', `[provider] watching ${bridge.label}`);
      return () => emitter.off('snapshot', handler);
    },
  };
}

export interface AgentSourceProviderOptions {
  onLog?: LogFn;
}

export function createDshProvider(opts: AgentSourceProviderOptions & { root?: string; workspace?: string } = {}): AiEventProvider {
  const bridge = new DshBridge({ root: opts.root, workspace: opts.workspace, onLog: (l, m) => opts.onLog?.(l, m) });
  return wrapLegacy(bridge, false, opts.onLog);
}

export function createCodexProvider(opts: AgentSourceProviderOptions = {}): AiEventProvider {
  const bridge = new CodexBridge({ onLog: (l, m) => opts.onLog?.(l, m) });
  return wrapLegacy(bridge, false, opts.onLog);
}

export function createClaudeProvider(opts: AgentSourceProviderOptions = {}): AiEventProvider {
  const bridge = new ClaudeBridge({ onLog: (l, m) => opts.onLog?.(l, m) });
  return wrapLegacy(bridge, false, opts.onLog);
}
