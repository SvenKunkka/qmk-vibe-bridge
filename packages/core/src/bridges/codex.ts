/**
 * Codex bridge — watches ~/.codex/sessions/<yyyy>/<mm>/<dd>/*.jsonl rollout
 * files and derives state from response_item events:
 *
 *   response_item:reasoning            -> thinking
 *   response_item:function_call / custom_tool_call / web_search_call / tool_search_call -> tool
 *   response_item:function_call_output -> tool result
 *   response_item:message (assistant)  -> assistant output
 *   event_msg:agent_message            -> done (final summary)
 *   event_msg:task_complete            -> done
 *   event_msg:user_message             -> thinking (new prompt)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentBridge, type AgentSnapshot } from '../agent-bridge';
import { AgentState, colorForState } from '@vibebridge/akp-codec';
import { JsonlWatcher, type LogExtractor, type WatchEvent, type WindowState } from './jsonl-watcher';

interface CodexPayload {
  type?: string;
  role?: string;
  name?: string;
  message?: string;
  status?: string;
  command?: string;
}

export class CodexExtractor implements LogExtractor {
  onLine(ev: WatchEvent): WindowState | null {
    const t = ev.obj.type as string;
    const payload = (ev.obj.payload ?? {}) as CodexPayload;
    if (t === 'event_msg') {
      switch (payload.type) {
        case 'user_message':
          return { state: AgentState.THINKING, text: 'new prompt', ts: ev.ts, confidence: 0.9 };
        case 'agent_message':
          return { state: AgentState.DONE, text: 'summary', ts: ev.ts, confidence: 0.9 };
        case 'task_started':
          return { state: AgentState.THINKING, text: 'task started', ts: ev.ts, confidence: 0.85 };
        case 'task_complete':
          return { state: AgentState.DONE, text: 'task complete', ts: ev.ts, confidence: 0.95 };
        default:
          return null;
      }
    }
    if (t === 'response_item') {
      switch (payload.type) {
        case 'reasoning':
          return { state: AgentState.THINKING, text: 'reasoning…', ts: ev.ts, confidence: 0.8 };
        case 'function_call':
        case 'custom_tool_call':
        case 'web_search_call':
        case 'tool_search_call':
          return { state: AgentState.TOOL, text: `tool: ${payload.name ?? payload.type}`, step: payload.name ?? '', ts: ev.ts, confidence: 0.95 };
        case 'function_call_output':
        case 'custom_tool_call_output':
          return { state: AgentState.TOOL, text: 'tool result', ts: ev.ts, confidence: 0.7 };
        case 'message': {
          if (payload.role === 'assistant') {
            return { state: AgentState.THINKING, text: 'assistant…', ts: ev.ts, confidence: 0.6 };
          }
          if (payload.role === 'user') {
            return { state: AgentState.THINKING, text: 'user input', ts: ev.ts, confidence: 0.7 };
          }
          return null;
        }
        case 'local_shell_call':
        case 'apply_patch_call':
          return { state: AgentState.TOOL, text: `tool: ${payload.type}`, ts: ev.ts, confidence: 0.9 };
        default:
          return null;
      }
    }
    if (t === 'turn_context' || t === 'session_meta') return null;
    return null;
  }

  resolve(window: WatchEvent[]): WindowState | null {
    if (window.length === 0) return null;
    const last = window[window.length - 1];
    const payload = (last.obj.payload ?? {}) as CodexPayload;
    const isCompletion =
      last.obj.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'agent_message');
    const age = Date.now() - last.ts;
    if (isCompletion && age > 30_000) {
      return { state: AgentState.IDLE, text: 'idle', ts: last.ts, confidence: 0.8 };
    }
    const hint = this.onLine(last);
    if (hint) return hint;
    return null;
  }
}

export interface CodexBridgeOptions {
  root?: string;
  intervalMs?: number;
  sessionFile?: string;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class CodexBridge extends AgentBridge {
  readonly id = 'codex';
  readonly label = 'Codex';
  private watcher: JsonlWatcher | null = null;
  private snapshot: AgentSnapshot | undefined;
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: CodexBridgeOptions;

  constructor(opts: CodexBridgeOptions = {}) {
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  static findLatest(root: string): string | null {
    if (!fs.existsSync(root)) return null;
    const holder: { best: { file: string; mtime: number } | null } = { best: null };
    const walk = (dir: string, depth: number) => {
      if (depth > 5) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes('rollout')) {
          try {
            const st = fs.statSync(p);
            if (!holder.best || st.mtimeMs > holder.best.mtime) holder.best = { file: p, mtime: st.mtimeMs };
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(root, 0);
    return holder.best?.file ?? null;
  }

  private async watch(): Promise<void> {
    const root = this.opts.root ?? path.join(os.homedir(), '.codex', 'sessions');
    const file = this.opts.sessionFile ?? CodexBridge.findLatest(root);
    if (!file) {
      this.opts.onLog?.('warn', '[codex] no rollout logs found under ' + root);
      return;
    }
    const createWatcher = (f: string) =>
      new JsonlWatcher(f, new CodexExtractor(), { intervalMs: this.opts.intervalMs ?? 1500, onLog: this.opts.onLog });

    const refresh = () => {
      const st = this.watcher?.resolveState();
      if (!st) return;
      this.snapshot = {
        state: st.state,
        agent: this.label,
        agentId: 'codex',
        session: path.basename(file, '.jsonl').slice(0, 40),
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
    this.timer = setInterval(() => {
      const latest = this.opts.sessionFile ?? CodexBridge.findLatest(root);
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
}
