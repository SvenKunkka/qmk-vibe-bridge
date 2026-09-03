/**
 * Claude Code bridge — watches ~/.claude/projects/<slug>/*.jsonl transcripts.
 * Claude Code transcript events:
 *
 *   user (with prompt)                       -> thinking
 *   assistant (message.content tool_use)     -> tool
 *   user (message.content tool_result)       -> tool result
 *   user (message.content[].is_error)        -> error
 *   assistant (final text, no tool_use)      -> assistant output / done-ish
 *   permission_request                       -> awaiting approval
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentBridge, type AgentSnapshot } from '../agent-bridge';
import { AgentState, colorForState } from '@vibebridge/akp-codec';
import { JsonlWatcher, type LogExtractor, type WatchEvent, type WindowState } from './jsonl-watcher';

interface ClaudeMsg {
  role?: string;
  content?: unknown;
}

const contentBlocks = (m: ClaudeMsg): Array<Record<string, unknown>> => {
  const c = m.content;
  if (Array.isArray(c)) return c as Array<Record<string, unknown>>;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return [];
};

export class ClaudeExtractor implements LogExtractor {
  onLine(ev: WatchEvent): WindowState | null {
    const t = ev.obj.type as string;
    if (t === 'permission_request') {
      return { state: AgentState.WAITING, text: 'approval requested', ts: ev.ts, confidence: 0.95 };
    }
    if (t !== 'user' && t !== 'assistant' && t !== 'system') return null;
    const msg = (ev.obj.message ?? {}) as ClaudeMsg;
    if (t === 'system' && msg.role === 'user') return null;
    const blocks = contentBlocks(msg);
    if (t === 'assistant') {
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      if (toolUses.length > 0) {
        const first = toolUses[0] as { name?: string };
        return { state: AgentState.TOOL, text: `tool: ${first.name ?? '?'}`, step: first.name ?? '', ts: ev.ts, confidence: 0.95 };
      }
      const texts = blocks.filter((b) => b.type === 'text').map((b) => String((b as { text?: unknown }).text ?? ''));
      const hasError = blocks.some((b) => (b as { is_error?: boolean }).is_error || (b as { type?: string }).type === 'error');
      if (hasError) return { state: AgentState.ERROR, text: 'error', ts: ev.ts, confidence: 0.8 };
      if (texts.length > 0) {
        return { state: AgentState.THINKING, text: texts[0].slice(0, 80), ts: ev.ts, confidence: 0.55 };
      }
      return { state: AgentState.THINKING, text: 'assistant…', ts: ev.ts, confidence: 0.5 };
    }
    if (t === 'user') {
      // check for tool results / errors
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (results.length > 0) {
        const hasErr = results.some((r) => (r as { is_error?: boolean }).is_error);
        if (hasErr) return { state: AgentState.ERROR, text: 'tool error', ts: ev.ts, confidence: 0.8 };
        return { state: AgentState.TOOL, text: 'tool result', ts: ev.ts, confidence: 0.6 };
      }
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text.trim()) {
        return { state: AgentState.THINKING, text: 'user prompt', ts: ev.ts, confidence: 0.9 };
      }
      return null;
    }
    return null;
  }

  resolve(window: WatchEvent[]): WindowState | null {
    if (window.length === 0) return null;
    const last = window[window.length - 1];
    const hint = this.onLine(last);
    if (hint) return hint;
    return null;
  }
}

export interface ClaudeBridgeOptions {
  root?: string;
  intervalMs?: number;
  sessionFile?: string;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class ClaudeBridge extends AgentBridge {
  readonly id = 'claude';
  readonly label = 'Claude Code';
  private watcher: JsonlWatcher | null = null;
  private snapshot: AgentSnapshot | undefined;
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: ClaudeBridgeOptions;

  constructor(opts: ClaudeBridgeOptions = {}) {
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
        else if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.endsWith('.zstd')) {
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
    const root = this.opts.root ?? path.join(os.homedir(), '.claude', 'projects');
    const file = this.opts.sessionFile ?? ClaudeBridge.findLatest(root);
    if (!file) {
      this.opts.onLog?.('warn', '[claude] no transcripts found under ' + root);
      return;
    }
    const createWatcher = (f: string) =>
      new JsonlWatcher(f, new ClaudeExtractor(), { intervalMs: this.opts.intervalMs ?? 1500, onLog: this.opts.onLog });

    const refresh = () => {
      const st = this.watcher?.resolveState();
      if (!st) return;
      this.snapshot = {
        state: st.state,
        agent: this.label,
        agentId: 'claude',
        session: path.basename(path.dirname(file)),
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
      const latest = this.opts.sessionFile ?? ClaudeBridge.findLatest(root);
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
