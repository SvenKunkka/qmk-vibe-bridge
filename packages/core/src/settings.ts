/**
 * Persistent settings: JSON file in the user config dir.
 * macOS: ~/Library/Application Support/AIKeyboardConsole/config.json
 * Linux: ~/.config/ai-keyboard-console/config.json
 * Windows: %APPDATA%/AIKeyboardConsole/config.json
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentState, RGB } from '@vibebridge/akp-codec';
import { DEFAULT_STATE_COLORS } from '@vibebridge/akp-codec';
import type { ActionName } from '@vibebridge/akp-codec';
import { normalizeLocale, type Locale } from './i18n';

export type ExecutorKind = 'macro' | 'command' | 'off';
export type LightingMode = 'auto' | 'solid' | 'off';

export interface DeviceConfig {
  id: string;
  label: string;
  kind: 'hid' | 'virtual';
  /** exact HID path (preferred — multi-interface safety, round 13) */
  path?: string;
  /** USB VID/PID for hid devices (fallback only, must be AKP-filtered) */
  vendorId?: number;
  productId?: number;
  /** TCP host:port for virtual devices */
  host?: string;
  port?: number;
  mtu: number;
  enabled: boolean;
}

export interface KeyMapping {
  /** F13..F24, KNOB_CW, KNOB_CCW, KNOB_PRESS, or custom key name */
  source: string;
  action: ActionName | string;
  /** for action === 'custom': what to type */
  text?: string;
  /** optional modifier macro for 'custom' (osascript keystroke with modifiers) */
  modifiers?: string[];
  /** double-tap count to trigger */
  tapCount?: number;
}

export interface AgentSourceConfig {
  id: string;
  kind: 'dsh' | 'codex' | 'claude' | 'virtual' | 'none';
  label: string;
  enabled: boolean;
  /** glob-ish root overrides */
  roots?: string[];
  /** DSH: optional exact workspace dir name to follow (scoped discovery) */
  workspace?: string;
  /** TCP port for virtual agents */
  port?: number;
  host?: string;
}

export interface MacroEntry {
  /** redundant but handy for custom entries */
  action?: ActionName | string;
  /** text to type after Enter-less (osascript keystroke) */
  type?: string;
  /** keycodes to press: e.g. ["enter"], ["escape"], ["ctrl+c"], ["fn","fn"] */
  keys?: string[];
  /** execute a shell command */
  command?: string;
  /** if true, send plain Enter (for approve/send) */
  enter?: boolean;
  /** focus a target app first, e.g. "Terminal", "iTerm2" */
  focusApp?: string;
}

export interface AppSettings {
  locale: Locale;
  devices: DeviceConfig[];
  keymap: KeyMapping[];
  agentSources: AgentSourceConfig[];
  activeAgentSource: string;
  executor: ExecutorKind;
  macros: Record<string, MacroEntry>;
  lighting: {
    mode: LightingMode;
    solidColor: RGB;
    brightness: number;
    effect: string;
    perKey: boolean;
    stateColors: Partial<Record<AgentState, RGB>>;
    /** Per AI software (agent source id: dsh/codex/claude/virtual) status-light
     *  color overrides. Key = agent source id, value = state -> color.
     *  Missing states fall back to `stateColors` / defaults. */
    perSourceColors: Record<string, Partial<Record<string, RGB>>>;
  };
  heartbeatMs: number;
  reconnect: boolean;
  /** round-15: default write policy is read-only */
  writePolicy?: 'read-only' | 'ask' | 'allow';
  /** round-15: user-assigned protocol profiles per exact interface path */
  profileAssignments?: Array<{ interfacePath: string; profileId: string }>;
  /** round-16 (P2-7): diagnostic — list every HID interface (default false) */
  showAllInterfaces?: boolean;
  /** round-17 §6: master kill switch — default ON (all writes disabled) */
  writesDisabled?: boolean;
  /** round-17: user-imported profiles (serialized ProtocolProfile) */
  importedProfiles?: Array<Record<string, unknown>>;
  /** round-17: definition bindings (interfacePath -> profileId + hash) */
  definitionBindings?: Array<{ interfacePath: string; profileId: string; definitionHash: string; boundAt: number }>;
  version: number;
}

export function defaultKeymap(): KeyMapping[] {
  return [
    { source: 'F13', action: 'select_agent' },
    { source: 'F14', action: 'approve' },
    { source: 'F15', action: 'reject' },
    { source: 'F16', action: 'new_task' },
    { source: 'F17', action: 'send' },
    { source: 'F18', action: 'dictate' },
    { source: 'F19', action: 'fast_mode' },
    { source: 'F20', action: 'reasoning_up' },
    { source: 'F21', action: 'reasoning_down' },
    { source: 'KNOB_CW', action: 'reasoning_up' },
    { source: 'KNOB_CCW', action: 'reasoning_down' },
    { source: 'KNOB_PRESS', action: 'send' },
  ];
}

export function defaultMacros(): Record<string, MacroEntry> {
  return {
    approve: { keys: ['enter'], focusApp: 'Terminal' },
    reject: { keys: ['escape'], focusApp: 'Terminal' },
    new_task: { keys: ['ctrl+c'], focusApp: 'Terminal', type: '' },
    send: { enter: true, focusApp: 'Terminal' },
    dictate: { keys: ['fn', 'fn'], focusApp: 'Terminal' },
    fast_mode: { type: '/fast\n', focusApp: 'Terminal' },
    reasoning_up: { type: '/reasoning high\n', focusApp: 'Terminal' },
    reasoning_down: { type: '/reasoning low\n', focusApp: 'Terminal' },
    select_agent: { type: 'codex\n', focusApp: 'Terminal' },
    cancel: { keys: ['ctrl+c'], focusApp: 'Terminal' },
    interrupt: { keys: ['ctrl+c'], focusApp: 'Terminal' },
    pause: { keys: ['escape'], focusApp: 'Terminal' },
    resume: { keys: ['enter'], focusApp: 'Terminal' },
  };
}

export function defaultSettings(): AppSettings {
  return {
    locale: 'en', // product default language is English (round-8)
    devices: [],
    keymap: defaultKeymap(),
    agentSources: [
      { id: 'dsh', kind: 'dsh', label: 'DeepSeek Harness', enabled: true },
      { id: 'codex', kind: 'codex', label: 'Codex', enabled: false },
      { id: 'claude', kind: 'claude', label: 'Claude Code', enabled: false },
      // OFF by default: a fresh config must not auto-spawn a reconnecting
      // virtual agent bridge before the simulator is started (round-5 fix)
      { id: 'virtual', kind: 'virtual', label: 'Virtual Agent', enabled: false, host: '127.0.0.1', port: 18903 },
    ],
    activeAgentSource: 'virtual',
    executor: 'macro',
    macros: defaultMacros(),
    lighting: {
      mode: 'auto',
      solidColor: { r: 255, g: 255, b: 255 },
      brightness: 60,
      effect: 'solid',
      perKey: true,
      stateColors: { ...DEFAULT_STATE_COLORS },
      perSourceColors: {},
    },
    heartbeatMs: 1500,
    reconnect: true,
    writePolicy: 'read-only',
    writesDisabled: true,
    profileAssignments: [],
    showAllInterfaces: false,
    importedProfiles: [],
    definitionBindings: [],
    version: 2,
  };
}

export function configDir(): string {
  const platform = process.platform;
  let base: string;
  if (platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support', 'AIKeyboardConsole');
  } else if (platform === 'win32') {
    base = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'AIKeyboardConsole');
  } else {
    base = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'ai-keyboard-console');
  }
  return base;
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export class SettingsStore {
  private settings: AppSettings;
  readonly path: string;

  constructor(pathOverride?: string) {
    this.path = pathOverride ?? configPath();
    this.settings = this.load();
  }

  private load(): AppSettings {
    try {
      if (fs.existsSync(this.path)) {
        const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
        return this.merge(raw);
      }
    } catch (err) {
      console.warn(`[settings] failed to load ${this.path}: ${(err as Error).message}`);
    }
    return defaultSettings();
  }

  private merge(raw: Partial<AppSettings>): AppSettings {
    const def = defaultSettings();
    return {
      ...def,
      ...raw,
      // round-8: persisted locale is normalized — missing field migrates to the
      // English default; legacy zh/zh-CN values stay Chinese (never reset)
      locale: normalizeLocale(raw.locale),
      keymap: raw.keymap ?? def.keymap,
      agentSources: raw.agentSources ?? def.agentSources,
      macros: { ...def.macros, ...(raw.macros ?? {}) },
      lighting: {
        ...def.lighting,
        ...(raw.lighting ?? {}),
        stateColors: { ...def.lighting.stateColors, ...(raw.lighting?.stateColors ?? {}) },
        perSourceColors: { ...(raw.lighting?.perSourceColors ?? {}) },
      },
      devices: raw.devices ?? def.devices,
      writePolicy: raw.writePolicy ?? def.writePolicy,
      writesDisabled: raw.writesDisabled ?? def.writesDisabled,
      profileAssignments: raw.profileAssignments ?? def.profileAssignments,
      showAllInterfaces: raw.showAllInterfaces ?? def.showAllInterfaces,
      importedProfiles: raw.importedProfiles ?? def.importedProfiles,
      definitionBindings: raw.definitionBindings ?? def.definitionBindings,
    };
  }

  get(): AppSettings {
    return this.settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = this.merge({ ...this.settings, ...patch });
    this.save();
    return this.settings;
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, JSON.stringify(this.settings, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[settings] failed to save ${this.path}: ${(err as Error).message}`);
    }
  }
}
