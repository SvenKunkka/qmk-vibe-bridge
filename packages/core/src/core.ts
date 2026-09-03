/**
 * ConsoleCore (round-15 rewrite). Wires the full layered pipeline:
 *
 *   AI Event Provider -> AI Event Normalizer -> Mapping Engine
 *     -> Capability Gate -> Protocol Adapter -> Transport -> Keyboard
 *
 * plus the Profile registry, device manager, write audit, settings and i18n.
 * Default behavior is read-only; every write passes the Capability Gate.
 */

import { EventEmitter } from 'node:events';
import { SettingsStore, type AppSettings, type DeviceConfig } from './settings';
import { translate, type Locale } from './i18n';
import { AiEventHub } from './ai/hub';
import type { AiEvent, AiEventType } from './ai/types';
import { SimulatorAiProvider } from './ai/providers/simulator';
import { createCodexProvider, createDshProvider, createClaudeProvider } from './ai/providers/agent-source';
import { WriteAudit } from './capabilities/audit';
import { CapabilityGate, type WritePolicy } from './capabilities/gate';
import { ProfileRegistry } from './profiles/registry';
import { viaProfile } from './profiles/builtin';
import { parseViaDefinition } from './definitions/via-definition';
import { LocalApiServer } from './api/server';
import { loadOrCreateToken, revokeToken } from './api/token';
import type { ApiServerConfig, ApiServerStatus, ConflictPolicy, InboundAgentEvent } from './api/types';
import { DeviceManager, type DeviceView } from './devices/manager';
import { MappingEngine, type MappedOp } from './mapping/engine';
import { createExecutor, type ActionExecutor, type ExecResult } from './actions';
import { KeymapManager } from './keymap';
import type { TransportCandidate, DeviceTransport } from './transports/types';
import { TcpSimulatorTransport } from './transports/tcp';
import type { ProtocolProfile, ViaDefinition } from './profiles/types';

/** Default opener: TCP candidates (simulator devices) work out of the box. */
function defaultOpenTransport(candidate: TransportCandidate): Promise<DeviceTransport> {
  if (candidate.kind !== 'tcp') {
    return Promise.reject(new Error(`no transport opener configured for kind "${candidate.kind}" — the app layer must inject platform drivers`));
  }
  const m = /^tcp:\/\/([^:]+):(\d+)$/.exec(candidate.path ?? '');
  if (!m) return Promise.reject(new Error(`invalid tcp path ${candidate.path}`));
  return Promise.resolve(
    new TcpSimulatorTransport({ id: candidate.id, label: candidate.label, host: m[1], port: Number(m[2]) }),
  );
}

export type CoreEvent =
  | { type: 'devices'; devices: DeviceView[] }
  | { type: 'deviceStatus'; device: DeviceView }
  | { type: 'aiEvent'; ev: AiEvent }
  | { type: 'mapped'; deviceId: string; ops: MappedOp[] }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'settings'; settings: AppSettings };

export interface CoreOptions {
  settingsPath?: string;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** platform enumerators + transport opener (app layer injects node-hid etc.) */
  enumerateInterfaces?: Array<(registry: ProfileRegistry) => Promise<TransportCandidate[]>>;
  openTransport?: (candidate: TransportCandidate) => Promise<DeviceTransport>;
  autoStart?: boolean;
}

interface DefinitionSourceLike {
  kind?: string;
  definition?: ViaDefinition;
  hash?: string;
  url?: string;
}

export class ConsoleCore extends EventEmitter {
  readonly settings: SettingsStore;
  readonly audit = new WriteAudit();
  readonly gate = new CapabilityGate(this.audit, 'read-only');
  readonly registry = new ProfileRegistry();
  readonly ai = new AiEventHub();
  readonly devices: DeviceManager;
  readonly mapping = new MappingEngine();
  readonly keymap = new KeymapManager([]);
  private readonly executor: ActionExecutor;
  private readonly logFn: CoreOptions['onLog'];
  private started = false;
  private lastMappedOps = new Map<string, MappedOp[]>();
  private localApi: LocalApiServer | null = null;
  private localApiToken = '';
  private localApiStorage: 'keychain' | 'file' | 'none' = 'file';

  constructor(opts: CoreOptions = {}) {
    super();
    this.logFn = opts.onLog;
    const log = (level: 'info' | 'warn' | 'error', msg: string) => {
      this.logFn?.(level, msg);
      this.emit('log', { type: 'log', level, msg });
    };
    this.settings = new SettingsStore(opts.settingsPath);
    this.keymap.setMappings(this.settings.get().keymap);

    this.devices = new DeviceManager({
      registry: this.registry,
      audit: this.audit,
      gate: this.gate,
      enumerators: opts.enumerateInterfaces,
      openTransport: opts.openTransport ?? defaultOpenTransport,
      onLog: log,
      onEvent: (ev) => {
        if (ev.type === 'status') {
          this.emit('deviceStatus', { type: 'deviceStatus', device: ev.device });
        } else if (ev.type === 'refresh') {
          this.emit('devices', { type: 'devices', devices: ev.devices });
        } else if (ev.type === 'op') {
          this.emit('log', { type: 'log', level: ev.result.ok ? 'info' : 'warn', msg: `[op] ${ev.op.label}: ${ev.result.ok ? 'ok' : ev.result.error}` });
        }
      },
    });

    this.executor = createExecutor(this.settings.get().executor, log);
    this.setupAiProviders();
    this.applyPersistedState();
  }

  private setupAiProviders(): void {
    const sources = this.settings.get().agentSources;
    for (const cfg of sources) {
      switch (cfg.kind) {
        case 'virtual': {
          const provider = new SimulatorAiProvider({
            host: cfg.host ?? '127.0.0.1',
            port: cfg.port ?? 18903,
            scripted: true,
            onLog: (l, m) => this.emit('log', { type: 'log', level: l, msg: m }),
          });
          this.ai.attach(provider, { start: cfg.enabled });
          break;
        }
        case 'dsh':
          this.ai.attach(createDshProvider({ root: cfg.roots?.[0], workspace: cfg.workspace, onLog: (l, m) => this.emit('log', { type: 'log', level: l, msg: m }) }), { start: cfg.enabled });
          break;
        case 'codex':
          this.ai.attach(createCodexProvider({ onLog: (l, m) => this.emit('log', { type: 'log', level: l, msg: m }) }), { start: cfg.enabled });
          break;
        case 'claude':
          this.ai.attach(createClaudeProvider({ onLog: (l, m) => this.emit('log', { type: 'log', level: l, msg: m }) }), { start: cfg.enabled });
          break;
        default:
          break;
      }
    }
    this.ai.setActiveSource(this.settings.get().activeAgentSource);

    // every AI event flows through the mapping engine -> gate -> adapters
    this.ai.on('event', (payload: { type: 'event'; ev: AiEvent }) => {
      this.emit('aiEvent', { type: 'aiEvent', ev: payload.ev });
      void this.dispatchAiEvent(payload.ev);
    });
  }

  private applyPersistedState(): void {
    const s = this.settings.get();
    if (s.writePolicy) this.gate.setPolicy(s.writePolicy);
    this.gate.setWritesDisabled(s.writesDisabled ?? true);
    for (const assign of s.profileAssignments ?? []) {
      this.registry.assignProfile(assign.interfacePath, assign.profileId);
    }
    if (s.showAllInterfaces) this.devices.setShowAllInterfaces(true);
    for (const raw of s.importedProfiles ?? []) {
      try {
        const profile = raw as unknown as ProtocolProfile;
        const def = (raw as { definition?: DefinitionSourceLike }).definition;
        this.registry.importProfile(profile, def?.definition as ViaDefinition | undefined);
      } catch {
        /* skip malformed imported profile on load */
      }
    }
    for (const b of s.definitionBindings ?? []) {
      try {
        this.registry.bindDefinition(b.interfacePath, b.profileId, b.definitionHash);
      } catch {
        /* binding hash stale -> skipped; user rebinds */
      }
    }
  }

  /** round-16 (P2-7): diagnostic "show all interfaces" toggle (persisted). */
  setShowAllInterfaces(v: boolean): void {
    this.devices.setShowAllInterfaces(v);
    this.settings.update({ showAllInterfaces: v });
    this.emit('settings', { type: 'settings', settings: this.settings.get() });
  }

  t(key: string, vars?: Record<string, string | number>): string {
    return translate(this.settings.get().locale, key, vars);
  }

  setLocale(locale: Locale): void {
    this.settings.update({ locale });
    this.emit('settings', { type: 'settings', settings: this.settings.get() });
  }

  getWritePolicy(): WritePolicy {
    return this.gate.getPolicy();
  }

  /** round-17 §6: master "disable all writes" switch. */
  setWritesDisabled(v: boolean): void {
    this.gate.setWritesDisabled(v);
    this.settings.update({ writesDisabled: v });
    this.emit('settings', { type: 'settings', settings: this.settings.get() });
  }

  getWritesDisabled(): boolean {
    return this.gate.getWritesDisabled();
  }

  setWritePolicy(policy: WritePolicy): void {
    this.gate.setPolicy(policy);
    this.settings.update({ writePolicy: policy });
    this.emit('settings', { type: 'settings', settings: this.settings.get() });
  }

  /** User assigns a profile to an exact interface (persisted). */
  assignProfile(interfacePath: string, profileId: string): void {
    this.registry.assignProfile(interfacePath, profileId);
    const assignments = (this.settings.get().profileAssignments ?? []).filter((a) => a.interfacePath !== interfacePath);
    assignments.push({ interfacePath, profileId });
    this.settings.update({ profileAssignments: assignments });
    this.emit('settings', { type: 'settings', settings: this.settings.get() });
  }

  listProfiles(): ProtocolProfile[] {
    return this.registry.all();
  }

  /**
   * Import a VIA definition JSON and create/refresh a user profile for it
   * (round-17). Validation, size limits, prototype-pollution guard and hash
   * pinning happen in parseViaDefinition. Import is NOT trust: first write
   * after a bind still requires confirmation.
   */
  importViaDefinition(rawJson: string): { ok: boolean; profileId?: string; errors: string[]; warnings: string[]; preview?: unknown } {
    const parsed = parseViaDefinition(rawJson);
    if (!parsed.ok || !parsed.definition) {
      return { ok: false, errors: parsed.errors, warnings: parsed.warnings };
    }
    const def = parsed.definition;
    const profileId = `via:${def.vendorId}:${def.productId}:${def.hash.slice(0, 8)}`;
    const profile: ProtocolProfile = {
      ...viaProfile,
      schemaVersion: 1,
      profileId,
      displayName: `${def.name} (VIA definition)`,
      vendor: def.name,
      vendorId: Number.parseInt(def.vendorId, 16),
      productId: Number.parseInt(def.productId, 16),
      definition: { kind: 'imported', definition: def, hash: def.hash },
      firmwareConstraints: { requiredFirmwareFeatures: [] },
      verifiedStatus: 'not-verified',
      hardwareValidation: { status: 'not-verified', platforms: [] },
      notes: 'User-imported VIA definition. Lighting capability is probed on the device (official get_value); definition gates identity only.',
    };
    this.registry.importProfile(profile, def);
    // persist
    const raw = JSON.parse(JSON.stringify(profile));
    (raw as { definition?: unknown }).definition = { kind: 'imported', definition: def, hash: def.hash };
    const existing = (this.settings.get().importedProfiles ?? []).filter((p) => (p as { profileId?: string }).profileId !== profileId);
    this.settings.update({ importedProfiles: [...existing, raw] });
    this.emit('settings', { type: 'settings', settings: this.settings.get() });
    return { ok: true, profileId, errors: [], warnings: parsed.warnings, preview: parsed.preview };
  }

  /** Bind an imported profile to an exact interface (rank-4 match). */
  bindDefinition(interfacePath: string, profileId: string): { ok: boolean; error?: string } {
    const def = this.registry.getDefinition(profileId);
    if (!def) return { ok: false, error: 'profile has no imported definition' };
    try {
      this.registry.bindDefinition(interfacePath, profileId, def.hash);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const bindings = (this.settings.get().definitionBindings ?? []).filter((b) => b.interfacePath !== interfacePath);
    bindings.push({ interfacePath, profileId, definitionHash: def.hash, boundAt: Date.now() });
    this.settings.update({ definitionBindings: bindings });
    this.emit('settings', { type: 'settings', settings: this.settings.get() });
    return { ok: true };
  }

  /** Unbind/unassign a profile from an interface (migration + unbind UI). */
  unbindProfile(interfacePath: string): void {
    this.registry.unassignProfile(interfacePath);
    const bindings = (this.settings.get().definitionBindings ?? []).filter((b) => b.interfacePath !== interfacePath);
    this.settings.update({ definitionBindings: bindings });
    this.emit('settings', { type: 'settings', settings: this.settings.get() });
  }

  /** Evidence + diagnostics export (secrets redacted by the caller policy). */
  exportDiagnostics(): Record<string, unknown> {
    return {
      version: '0.9.0',
      ts: Date.now(),
      profiles: this.registry.all().map((p) => ({
        profileId: p.profileId,
        protocol: p.protocol,
        protocolVersion: p.protocolVersion,
        verifiedStatus: p.verifiedStatus,
        hardwareValidation: p.hardwareValidation?.status,
        capabilities: p.capabilities,
        evidence: p.evidence?.map((e) => ({ url: e.url, type: e.type, version: e.version })),
        safetyPolicy: p.safetyPolicy,
      })),
      devices: this.devices.list().map((d) => ({
        id: d.id, label: d.label, status: d.status, profileId: d.profileId,
        adapterId: d.adapterId, capabilitiesKnown: d.capabilitiesKnown, writeCount: d.writeCount,
      })),
      audit: this.audit.recent(20),
      writePolicy: this.gate.getPolicy(),
      showAllInterfaces: this.devices.isShowAllInterfaces,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.devices.refresh();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.devices.clear();
    for (const p of this.ai.providersList()) p.stop();
  }

  async refreshDevices(): Promise<DeviceView[]> {
    return this.devices.refresh();
  }

  listDevices(): DeviceView[] {
    return this.devices.list();
  }

  /** Connect an interface (optionally forcing a profile). */
  async connectDevice(id: string, profileId?: string): Promise<DeviceView> {
    const v = await this.devices.connect(id, profileId);
    this.emit('deviceStatus', { type: 'deviceStatus', device: v });
    return v;
  }

  async disconnectDevice(id: string): Promise<void> {
    await this.devices.disconnect(id);
  }

  setDeviceWriteEnabled(id: string, enabled: boolean): void {
    this.devices.setUserWriteEnabled(id, enabled);
  }

  recentAudit(limit = 50) {
    return this.audit.recent(limit);
  }

  writeCount(deviceId?: string): number {
    return this.audit.countWrites(deviceId);
  }

  /** Map the latest AI event for a device and report what WOULD happen. */
  previewOps(deviceId: string): MappedOp[] {
    const ev = this.ai.getLatest();
    const device = this.devices.get(deviceId);
    if (!ev || !device || !device.capabilities) return [];
    return this.mapping.map(ev, { deviceId, caps: device.capabilities });
  }

  /** Resolve status-light color overrides for an agent source: per-source
   *  config merged over the global `stateColors` (per-source wins). */
  private colorsForSource(source: string): Partial<Record<string, { r: number; g: number; b: number }>> {
    const lighting = this.settings.get().lighting;
    const merged: Record<string, { r: number; g: number; b: number }> = {};
    for (const [state, color] of Object.entries(lighting.stateColors ?? {})) {
      if (color) merged[state] = color;
    }
    for (const [state, color] of Object.entries(lighting.perSourceColors?.[source] ?? {})) {
      if (color) merged[state] = color;
    }
    return merged;
  }

  /** AI event -> mapped ops -> gate -> adapter (write path). */
  async dispatchAiEvent(ev: AiEvent): Promise<void> {
    const colors = this.colorsForSource(ev.source);
    for (const device of this.devices.list()) {
      const caps = device.capabilities;
      if (!caps || device.status === 'disconnected') continue;
      const mapped = this.mapping.map(ev, { deviceId: device.id, caps }, colors);
      this.lastMappedOps.set(device.id, mapped);
      this.emit('mapped', { type: 'mapped', deviceId: device.id, ops: mapped });
      for (const m of mapped) {
        // only feasible ops follow the AI state automatically — the gate still
        // guards every write
        if (!m.feasible) continue;
        await this.devices.applyOp(m.op);
      }
    }
  }

  /** Programmatic op trigger (UI "pending operation" panel). */
  async triggerOp(op: Parameters<DeviceManager['applyOp']>[0]): Promise<{ ok: boolean; error?: string }> {
    return this.devices.applyOp(op);
  }

  /** Confirm an ask-policy op (round-16 P2-6). */
  async confirmOp(token: string, op?: Parameters<DeviceManager['confirmOp']>[1]): Promise<{ ok: boolean; error?: string }> {
    return this.devices.confirmOp(token, op);
  }

  pendingConfirmations() {
    return this.devices.pendingConfirmationsList();
  }

  /** Keep old action API for the keymap/executor paths. */
  async handleCmd(cmd: { action: string; source: string; ts?: number }, deviceId: string): Promise<ExecResult | null> {
    this.emit('log', { type: 'log', level: 'info', msg: `[keyboard] action=${cmd.action} key=${cmd.source}` });
    const entry = this.settings.get().macros[cmd.action];
    const result = await this.executor.execute(cmd.action, entry);
    this.emit('log', { type: 'log', level: 'info', msg: `[action] ${cmd.action} -> ${result.ok ? 'ok' : result.error ?? 'failed'}` });
    return result;
  }

  triggerAction(action: string, source = 'ui'): Promise<ExecResult | null> {
    return this.handleCmd({ action, source }, 'ui');
  }

  getExecutor(): ActionExecutor {
    return this.executor;
  }

  isRunning(): boolean {
    return this.started;
  }

  /** Register a virtual TCP device (simulator keyboard). Connect is explicit:
   *  the caller decides which profile (if any) applies — registering alone
   *  never assigns a profile (round-15: no implicit protocol assignment). */
  async addSimulatorDevice(cfg: DeviceConfig): Promise<DeviceView | null> {
    if (cfg.kind !== 'virtual') return null;
    const candidate: TransportCandidate = {
      id: cfg.id,
      label: cfg.label,
      kind: 'tcp',
      path: `tcp://${cfg.host ?? '127.0.0.1'}:${cfg.port ?? 18902}`,
    };
    this.devices.registerCandidate(candidate);
    return this.devices.get(cfg.id) ?? null;
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    const s = this.settings.update(patch);
    if (patch.locale !== undefined) {
      this.emit('settings', { type: 'settings', settings: s });
    }
    if (patch.agentSources) {
      this.reconfigureProviders();
    }
    return s;
  }

  private reconfigureProviders(): void {
    for (const p of this.ai.providersList()) {
      p.stop();
      this.ai.detach(p.id);
    }
    this.setupAiProviders();
  }

  // ---- local Agent API (round-17 §5) ----

  /** Start the 127.0.0.1-only local API with a persisted token. */
  async startLocalApi(cfg: ApiServerConfig = {}): Promise<ApiServerStatus> {
    if (this.localApi) return this.localApi.status;
    const loaded = loadOrCreateToken(this.settings.path ? this.settings.path.replace(/config\.json$/, '') : process.cwd(), this.logFn);
    if (loaded.storage === 'none') {
      return { running: false, host: cfg.host ?? '127.0.0.1', port: 0, tokenConfigured: false, tokenStorage: 'none', conflictPolicy: cfg.conflictPolicy ?? 'priority' };
    }
    this.localApiToken = loaded.token;
    this.localApiStorage = loaded.storage;
    const server = new LocalApiServer(
      { host: '127.0.0.1', port: cfg.port ?? 0, token: loaded.token, ...cfg },
      {
        configDir: this.settings.path.replace(/config\.json$/, ''),
        onLog: this.logFn,
        onEvent: (ev) => {
          this.ai.emit('event', { type: 'event', ev });
        },
      },
    );
    this.localApi = server;
    await server.start();
    return server.status;
  }

  async stopLocalApi(): Promise<void> {
    if (this.localApi) {
      await this.localApi.stop();
      this.localApi = null;
    }
  }

  getLocalApiStatus(): ApiServerStatus | null {
    return this.localApi?.status ?? null;
  }

  /** UI-only: the token is displayed in the Providers page, never logged. */
  getLocalApiToken(): string {
    return this.localApiToken;
  }

  revokeLocalApiToken(): void {
    const dir = this.settings.path.replace(/config\.json$/, '');
    revokeToken(dir);
    this.localApiToken = '';
    this.localApiStorage = 'none';
  }

  setConflictPolicy(p: ConflictPolicy, pinnedSessionId?: string): void {
    this.localApi?.setConflictPolicy(p, pinnedSessionId);
  }

  /** programmatic ingest (used by tests + CLI examples) */
  ingestAgentEvent(ev: InboundAgentEvent): { code: number; error?: string } {
    if (!this.localApi) return { code: 503, error: 'local API not running' };
    return this.localApi.ingestEvent(ev);
  }
}

export type { AiEventType, DeviceView, MappedOp, ExecResult };
