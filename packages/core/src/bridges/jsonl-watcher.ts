/**
 * Shared JSONL watcher machinery for DSH / Codex / Claude log tails.
 *
 * Files may be plain .jsonl or .zstd compressed (DSH compresses live). The
 * watcher polls for mtime/size changes, decodes new content, feeds each line
 * to a format-specific extractor, and keeps a rolling window of the most
 * recent events to derive the current agent state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { AgentSnapshot } from '../agent-bridge';
import { AgentState } from '@vibebridge/akp-codec';

export interface WatchEvent {
  seq: number;
  ts: number;
  obj: Record<string, unknown>;
  raw: string;
}

export interface WindowState {
  state: AgentState;
  text?: string;
  step?: string;
  session?: string;
  progress?: number;
  ts: number;
  confidence: number;
}

export interface LogExtractor {
  /** Process one parsed line; returns a window state hint or null. */
  onLine(ev: WatchEvent): WindowState | null;
  /** Combined with the current window, derive the final state. */
  resolve(window: WatchEvent[]): WindowState | null;
}

const isZstd = (file: string): boolean => file.endsWith('.zstd') || file.endsWith('.zst');

function decodeZstd(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('unzstd', ['-c', '--no-progress', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`unzstd failed (${code}): ${err.slice(0, 200)}`));
    });
  });
}

export interface JsonlWatchOptions {
  /** poll interval ms */
  intervalMs?: number;
  /** how many recent events to keep for state resolution */
  windowSize?: number;
  /** maximum file size to decode (bytes) */
  maxDecodeBytes?: number;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface ResolvedOptions {
  intervalMs: number;
  windowSize: number;
  maxDecodeBytes: number;
  onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class JsonlWatcher {
  private lastSize = -1;
  private lastMtime = -1;
  private readonly maxSeq = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private readonly window: WatchEvent[] = [];
  private readonly extractor: LogExtractor;
  private readonly opts: ResolvedOptions;

  constructor(
    private readonly file: string,
    extractor: LogExtractor,
    opts: JsonlWatchOptions = {},
  ) {
    this.extractor = extractor;
    this.opts = {
      intervalMs: opts.intervalMs ?? 2000,
      windowSize: opts.windowSize ?? 200,
      maxDecodeBytes: opts.maxDecodeBytes ?? 128 * 1024 * 1024,
      onLog: opts.onLog ?? (() => {}),
    };
  }

  get filePath(): string {
    return this.file;
  }

  async start(): Promise<void> {
    await this.poll(); // initial scan
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  currentWindow(): WatchEvent[] {
    return [...this.window];
  }

  private async poll(): Promise<void> {
    try {
      const stat = fs.statSync(this.file);
      if (stat.size === this.lastSize && stat.mtimeMs === this.lastMtime) return;
      const before = this.window.length;
      if (isZstd(this.file)) {
        if (stat.size > this.opts.maxDecodeBytes) {
          this.opts.onLog('warn', `[watch] ${this.file} too large to decode (${stat.size}B)`);
          return;
        }
        const text = await decodeZstd(this.file);
        this.ingest(text, stat);
      } else {
        const fd = fs.openSync(this.file, 'r');
        try {
          const bytes = Buffer.alloc(Math.min(stat.size, this.opts.maxDecodeBytes));
          const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
          this.ingest(bytes.toString('utf8').slice(0, read), stat);
        } finally {
          fs.closeSync(fd);
        }
      }
      this.lastSize = stat.size;
      this.lastMtime = stat.mtimeMs;
      this.opts.onLog('info', `[watch] ${path.basename(this.file)} processed ${this.window.length - before} new events`);
    } catch (err) {
      this.opts.onLog('warn', `[watch] ${this.file}: ${(err as Error).message}`);
    }
  }

  private ingest(text: string, stat: { size: number; mtimeMs: number }): void {
    // If file shrank or mtime moved backwards, it was rewritten — reset window.
    if (stat.size < this.lastSize || stat.mtimeMs < this.lastMtime) {
      this.window.length = 0;
      this.maxSeq.clear();
    }
    let lastSeen = this.maxSeq.get(this.file) ?? -1;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const seq = typeof obj.seq === 'number' ? obj.seq : (typeof obj.sequence === 'number' ? obj.sequence : -1);
      if (seq >= 0 && seq <= lastSeen) continue;
      if (seq >= 0) lastSeen = seq;
      const ts = typeof obj.time === 'number' ? obj.time : typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Date.now();
      const ev: WatchEvent = { seq, ts: Number.isFinite(ts) ? ts : Date.now(), obj, raw: line };
      this.window.push(ev);
      const hint = this.extractor.onLine(ev);
      if (hint) this.windowHints.push(hint);
      if (this.window.length > this.opts.windowSize) this.window.shift();
      if (this.windowHints.length > this.opts.windowSize * 2) this.windowHints.shift();
    }
    this.maxSeq.set(this.file, lastSeen);
  }

  private windowHints: WindowState[] = [];

  /** Derive the current state from the watched window. */
  resolveState(): WindowState | null {
    return this.extractor.resolve(this.window);
  }

  recentHints(): WindowState[] {
    return this.windowHints;
  }
}

export function recent<T>(arr: T[], n: number): T[] {
  return arr.slice(Math.max(0, arr.length - n));
}

export function windowTs(ev: WatchEvent): number {
  return ev.ts;
}

export { AgentState };
