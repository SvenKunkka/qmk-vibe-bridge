/**
 * DeepSeek Harness bridge — watches ~/.dsh/sessions/<workspace>/<session-id>/session.jsonl[.zstd]
 * and derives agent state from the real DSH event stream:
 *
 *   user/message          -> user prompt (thinking begins)
 *   turn/start            -> thinking
 *   step/start            -> tool step begins
 *   tool/call             -> tool executing (purple)
 *   tool/result, step/end -> tool finished
 *   assistant/chunk {chunk.type:'finish', reason.kind:'error'} -> error
 *   turn/end {reason.kind:'success'|'error'}                  -> done / error
 *   approval/policy + agent/inbox/spliced                     -> awaiting approval
 *
 * DSH logs are zstd-compressed; decoding uses the `unzstd` CLI (macOS: brew
 * install zstd). Confidence is reported so the UI can show heuristics clearly.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentBridge, type AgentSnapshot } from '../agent-bridge';
import { AgentState, colorForState } from '@vibebridge/akp-codec';
import { JsonlWatcher, type LogExtractor, type WatchEvent, type WindowState } from './jsonl-watcher';

interface DshData {
  turn?: number;
  step?: number;
  reason?: { kind?: string };
  chunk?: { type?: string; reason?: { kind?: string } };
  policy?: string;
  callId?: string;
  name?: string;
  message?: Record<string, unknown>;
  inserted?: unknown[];
  removedCount?: number;
}

const unwrap = (ev: WatchEvent): DshData => {
  const d = ev.obj.data as Record<string, unknown> | undefined;
  return (d ?? {}) as DshData;
};

export class DshExtractor implements LogExtractor {
  onLine(ev: WatchEvent): WindowState | null {
    const t = ev.obj.type as string;
    const d = unwrap(ev);
    switch (t) {
      case 'user/message':
        return { state: AgentState.THINKING, text: 'user prompt', ts: ev.ts, confidence: 0.9 };
      case 'turn/start':
        return { state: AgentState.THINKING, text: `turn ${d.turn ?? ''}`.trim(), step: `turn ${d.turn ?? 1}`, ts: ev.ts, confidence: 0.95 };
      case 'step/start':
        return { state: AgentState.THINKING, text: `step ${d.step ?? ''}`.trim(), step: `step ${d.step ?? 1}`, ts: ev.ts, confidence: 0.8 };
      case 'tool/call':
        return { state: AgentState.TOOL, text: `tool: ${d.name ?? '?'}`, step: `tool ${d.name ?? ''}`, ts: ev.ts, confidence: 0.95 };
      case 'tool/result':
        return { state: AgentState.TOOL, text: 'tool result', ts: ev.ts, confidence: 0.7 };
      case 'step/end':
        return { state: AgentState.THINKING, text: 'step done', ts: ev.ts, confidence: 0.6 };
      case 'turn/end': {
        const kind = d.reason?.kind;
        if (kind === 'error') {
          return { state: AgentState.ERROR, text: 'turn failed', ts: ev.ts, confidence: 0.95 };
        }
        return { state: AgentState.DONE, text: 'turn finished', ts: ev.ts, confidence: 0.95 };
      }
      case 'assistant/chunk': {
        if (d.chunk?.type === 'finish' && d.chunk.reason?.kind === 'error') {
          return { state: AgentState.ERROR, text: 'completion error', ts: ev.ts, confidence: 0.9 };
        }
        return { state: AgentState.THINKING, text: 'assistant…', ts: ev.ts, confidence: 0.5 };
      }
      case 'approval/policy': {
        // policy != 'never' means manual approval is in play
        const policy = d.policy ?? 'never';
        if (policy !== 'never' && policy !== 'allow') {
          return { state: AgentState.WAITING, text: `approval policy: ${policy}`, ts: ev.ts, confidence: 0.6 };
        }
        return null;
      }
      case 'agent/inbox/spliced': {
        const inserted = d.inserted ?? [];
        const text = JSON.stringify(inserted).toLowerCase();
        if (inserted.length > 0 && (text.includes('approv') || text.includes('permission') || text.includes('allow'))) {
          return { state: AgentState.WAITING, text: 'approval requested', ts: ev.ts, confidence: 0.7 };
        }
        return null;
      }
      default:
        return null;
    }
  }

  resolve(window: WatchEvent[]): WindowState | null {
    if (window.length === 0) return null;
    const last = window[window.length - 1];
    const t = last.obj.type as string;
    const d = unwrap(last);
    // idle: no activity within the last 60s and the last event is a completion
    const now = Date.now();
    const age = now - last.ts;
    if (t === 'turn/end' && d.reason?.kind !== 'error' && age > 30_000) {
      return { state: AgentState.IDLE, text: 'idle', ts: last.ts, confidence: 0.8 };
    }
    if (t === 'turn/end' && d.reason?.kind === 'error') {
      return { state: AgentState.ERROR, text: 'turn failed', ts: last.ts, confidence: 0.95 };
    }
    const hint = this.onLine(last);
    if (hint) return hint;
    // fall back to the most recent hint
    return null;
  }
}

export interface DshBridgeOptions {
  /** root containing workspace dirs: default ~/.dsh/sessions */
  root?: string;
  /** optional exact workspace directory name to follow (e.g.
   * '--Users-keychron-Documents-Obsidian--'). When set, discovery is scoped
   * to root/<workspace> so sessions from other workspaces never leak in. */
  workspace?: string;
  /** poll interval ms */
  intervalMs?: number;
  /** optional explicit session file (bypasses auto-discovery) */
  sessionFile?: string;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class DshBridge extends AgentBridge {
  readonly id = 'dsh';
  readonly label = 'DeepSeek Harness';
  private watcher: JsonlWatcher | null = null;
  private snapshot: AgentSnapshot | undefined;
  private readonly opts: DshBridgeOptions;

  constructor(opts: DshBridgeOptions = {}) {
    super();
    this.opts = opts;
  }

  getSnapshot(): AgentSnapshot | undefined {
    return this.snapshot;
  }

  override start(): void {
    super.start();
    void this.watch();
  }

  override stop(): void {
    super.stop();
    this.watcher?.stop();
    this.watcher = null;
    if (this.watcherStartTimer) {
      clearInterval(this.watcherStartTimer);
      this.watcherStartTimer = null;
    }
  }

  /** Find the most recently modified session log under the root. */
  static findLatest(root: string, workspace?: string): string | null {
    if (!fs.existsSync(root)) return null;
    // scope discovery to the requested workspace so sessions from other
    // workspaces never leak into this bridge (P1 fix)
    const scope = workspace ? path.join(root, workspace) : root;
    if (!fs.existsSync(scope)) return null;
    const holder: { best: { file: string; mtime: number } | null } = { best: null };
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && (e.name === 'session.jsonl' || e.name === 'session.jsonl.zstd')) {
          try {
            const st = fs.statSync(p);
            if (!holder.best || st.mtimeMs > holder.best.mtime) holder.best = { file: p, mtime: st.mtimeMs };
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(scope, 0);
    return holder.best?.file ?? null;
  }

  private async watch(): Promise<void> {
    const root = this.opts.root ?? path.join(os.homedir(), '.dsh', 'sessions');
    const file = this.opts.sessionFile ?? DshBridge.findLatest(root, this.opts.workspace);
    if (!file) {
      this.opts.onLog?.('warn', '[dsh] no session logs found under ' + root + (this.opts.workspace ? `/${this.opts.workspace}` : ''));
      return;
    }
    const createWatcher = (f: string) =>
      new JsonlWatcher(f, new DshExtractor(), { intervalMs: this.opts.intervalMs ?? 1500, onLog: this.opts.onLog });

    const refresh = () => {
      const st = this.watcher?.resolveState();
      if (!st) return;
      // derive session/workspace from the CURRENT watcher path, never from a
      // stale closure capture (P1 fix)
      const current = this.watcher?.filePath ?? file;
      this.snapshot = {
        state: st.state,
        agent: this.label,
        agentId: 'dsh',
        session: path.basename(path.dirname(current)),
        workspace: path.basename(path.dirname(path.dirname(current))),
        text: st.text,
        step: st.step,
        progress: st.progress,
        color: colorForState(st.state),
        ts: st.ts,
        source: this.id,
        confidence: st.confidence,
      };
      this.emit('snapshot', this.snapshot);
    };

    this.watcher = createWatcher(file);
    await this.watcher.start();
    refresh();

    // periodically re-discover the newest session log in the SAME workspace
    this.watcherStartTimer = setInterval(() => {
      const latest = this.opts.sessionFile ?? DshBridge.findLatest(root, this.opts.workspace);
      if (!this.watcher) return;
      if (latest && latest !== this.watcher.filePath) {
        this.watcher.stop();
        this.watcher = createWatcher(latest);
        void this.watcher.start().then(refresh);
      } else {
        refresh();
      }
    }, (this.opts.intervalMs ?? 1500) * 4);
  }

  private watcherStartTimer: NodeJS.Timeout | null = null;
}
