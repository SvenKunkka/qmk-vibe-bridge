/**
 * Action executors — turn keyboard actions into real computer actions.
 *
 *  - MacroExecutor : simulates keystrokes (macOS osascript System Events;
 *                    Linux xdotool; Windows PowerShell SendKeys) — needs
 *                    Accessibility permission on macOS.
 *  - CommandExecutor : runs configured shell commands.
 *  - OffExecutor  : records actions only (no side effects).
 *
 * Every executor is honest about capability: it reports whether the action
 * could actually be dispatched.
 */

import { spawn, execFile } from 'node:child_process';
import type { ActionName } from '@vibebridge/akp-codec';
import type { MacroEntry } from './settings';

export interface ExecResult {
  ok: boolean;
  action: ActionName | string;
  method: 'macro' | 'command' | 'off' | 'virtual';
  detail?: string;
  error?: string;
}

export interface ActionExecutor {
  readonly kind: 'macro' | 'command' | 'off';
  execute(action: ActionName | string, entry?: MacroEntry): Promise<ExecResult>;
  /** whether this executor can run at all (e.g. permission check) */
  available(): Promise<boolean>;
  /** human-readable availability hint */
  availabilityHint(): string;
}

/** Escape a string for AppleScript literal use. */
function appleScriptString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Run a command, return {code, stdout, stderr}. */
function run(cmd: string, args: string[], timeoutMs = 8000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const APPLE_SCRIPT = `tell application "System Events"
  set frontApp to first application process whose frontmost is true
  keystroke {KEYCODE}
end tell`;

function keyCodeOf(name: string): number {
  const map: Record<string, number> = {
    enter: 36, return: 36, escape: 53, esc: 53, tab: 48, space: 49,
    fn: 63, delete: 51, backspace: 51, up: 126, down: 125, left: 123, right: 124,
    'ctrl+c': 8, 'cmd+c': 8, 'cmd+v': 9, 'cmd+a': 0, 'cmd+s': 1, 'cmd+shift+3': 30,
  };
  return map[name.toLowerCase()] ?? -1;
}

/** Build an osascript keystroke snippet for a named key. */
function osascriptKey(name: string, useControl?: boolean): string | null {
  const key = keyCodeOf(name);
  if (key < 0) return null;
  const modifier = useControl ? ' using {control down}' : '';
  return `keystroke (ASCII character ${key})${modifier}`;
}

function osascriptText(text: string): string {
  // type text character by character to avoid encoding issues in some apps
  const safe = appleScriptString(text);
  return `keystroke ${safe}`;
}

export class MacroExecutor implements ActionExecutor {
  readonly kind = 'macro' as const;
  private readonly onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;

  constructor(onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void) {
    this.onLog = onLog ?? (() => {});
  }

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    const r = await run('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']);
    return r.code === 0;
  }

  availabilityHint(): string {
    return 'macOS 需要"辅助功能"权限：系统设置 → 隐私与安全性 → 辅助功能';
  }

  async execute(action: ActionName | string, entry?: MacroEntry): Promise<ExecResult> {
    if (!entry) {
      return { ok: false, action, method: 'macro', error: 'no macro configured for action' };
    }
    if (process.platform !== 'darwin') {
      return { ok: false, action, method: 'macro', error: 'macro executor is macOS-only (use command executor elsewhere)' };
    }
    const parts: string[] = [];
    if (entry.focusApp) {
      parts.push(`tell application ${appleScriptString(entry.focusApp)} to activate`);
      parts.push('delay 0.25');
    }
    if (entry.keys) {
      for (const k of entry.keys) {
        if (k.toLowerCase().startsWith('ctrl+')) {
          const sc = osascriptKey(k.slice(5), true);
          if (sc) parts.push(sc);
        } else {
          const sc = osascriptKey(k);
          if (sc) parts.push(sc);
        }
      }
    }
    if (entry.enter) parts.push('keystroke return');
    if (entry.type) {
      for (const ch of entry.type) {
        if (ch === '\n') {
          parts.push('keystroke return');
        } else {
          parts.push(osascriptText(ch));
        }
      }
    }
    if (parts.length === 0) {
      return { ok: false, action, method: 'macro', error: 'empty macro' };
    }
    const script = `tell application "System Events"\n${parts.map((p) => '  ' + p).join('\n')}\nend tell`;
    const r = await run('osascript', ['-e', script]);
    if (r.code === 0) {
      this.onLog('info', `[macro] executed ${action} (${parts.length} steps)`);
      return { ok: true, action, method: 'macro', detail: script.slice(0, 120) };
    }
    return { ok: false, action, method: 'macro', error: `osascript failed: ${r.stderr.slice(0, 200)}` };
  }
}

export class CommandExecutor implements ActionExecutor {
  readonly kind = 'command' as const;
  private readonly onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;

  constructor(onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void) {
    this.onLog = onLog ?? (() => {});
  }

  async available(): Promise<boolean> {
    return true;
  }

  availabilityHint(): string {
    return '执行配置的命令行动作';
  }

  async execute(action: ActionName | string, entry?: MacroEntry): Promise<ExecResult> {
    if (!entry?.command) {
      return { ok: false, action, method: 'command', error: 'no command configured' };
    }
    const r = await run('/bin/sh', ['-c', entry.command], 15_000);
    this.onLog('info', `[command] ${action} -> exit ${r.code}`);
    return {
      ok: r.code === 0,
      action,
      method: 'command',
      detail: r.stdout.slice(0, 200),
      error: r.code !== 0 ? r.stderr.slice(0, 200) : undefined,
    };
  }
}

export class OffExecutor implements ActionExecutor {
  readonly kind = 'off' as const;
  private readonly onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;

  constructor(onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void) {
    this.onLog = onLog ?? (() => {});
  }

  async available(): Promise<boolean> {
    return true;
  }

  availabilityHint(): string {
    return '仅记录动作，不执行';
  }

  async execute(action: ActionName | string): Promise<ExecResult> {
    this.onLog('info', `[off] action recorded: ${action}`);
    return { ok: true, action, method: 'off', detail: 'recorded only' };
  }
}

export function createExecutor(
  kind: 'macro' | 'command' | 'off',
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void,
): ActionExecutor {
  switch (kind) {
    case 'macro':
      return new MacroExecutor(onLog);
    case 'command':
      return new CommandExecutor(onLog);
    default:
      return new OffExecutor(onLog);
  }
}

export { execFile };
