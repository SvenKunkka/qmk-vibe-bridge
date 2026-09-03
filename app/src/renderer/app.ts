/**
 * Renderer (round-15). English by default, Chinese switchable and persisted.
 * Views: Agent / Devices / Pending ops / Write audit / Settings.
 */

// ---- tiny i18n (renderer side; canonical dictionaries live in core) ----
type Locale = 'en' | 'zh';
let locale: Locale = 'en';

const DICT: Record<string, { en: string; zh: string }> = {
  'app.title': { en: 'Vibe Bridge', zh: 'Vibe Bridge' },
  'app.subtitle': { en: 'AI agents → your keyboard, over its own protocols', zh: '把 AI Agent 安全地桥接到你的键盘' },
  'btn.lang': { en: '中文', zh: 'English' },
  'nav.agent': { en: 'Agent', zh: 'Agent' },
  'nav.home': { en: 'Home', zh: '首页' },
  'nav.devices': { en: 'Devices', zh: '设备' },
  'nav.mapping': { en: 'Mapping', zh: '映射' },
  'nav.lights': { en: 'Status Lights', zh: '状态灯' },
  'nav.providers': { en: 'Providers', zh: 'Providers' },
  'nav.profiles': { en: 'Profiles', zh: 'Profiles' },
  'nav.activity': { en: 'Activity & Audit', zh: '活动与审计' },
  'nav.compat': { en: 'Compatibility', zh: '兼容性' },
  'nav.audit': { en: 'Write audit', zh: '写入审计' },
  'nav.settings': { en: 'Settings', zh: '设置' },
  'devices.title': { en: 'Devices', zh: '设备' },
  'devices.refresh': { en: '⟳ Refresh', zh: '⟳ 刷新' },
  'devices.none': { en: 'No devices found', zh: '未发现设备' },
  'devices.readonlyBanner': { en: 'QMK Raw HID transport found. No verified control profile is selected. The device will remain read-only.', zh: '发现 QMK Raw HID 传输通道，但未选择已验证的控制 Profile。该设备将保持只读。' },
  'devices.readonlyDefault': { en: 'Default behavior is read-only. Writes require a verified profile match and the Capability Gate.', zh: '默认行为是只读。写入需要匹配已验证的 Profile 并通过 Capability Gate。' },
  'device.hardware-detected': { en: 'Hardware detected', zh: '检测到硬件' },
  'device.transport-available': { en: 'Transport found', zh: '发现传输通道' },
  'device.protocol-identified': { en: 'Protocol identified', zh: '协议已识别' },
  'device.capabilities-known': { en: 'Capabilities known', zh: '能力已知' },
  'device.limited': { en: 'Limited support', zh: '有限支持' },
  'device.ready': { en: 'Ready', zh: '就绪' },
  'device.unsupported': { en: 'Unsupported', zh: '不支持' },
  'device.permission-denied': { en: 'Permission denied', zh: '权限被拒绝' },
  'device.disconnected': { en: 'Disconnected', zh: '已断开' },
  'device.error': { en: 'Error', zh: '错误' },
  'device.connect': { en: 'Connect', zh: '连接' },
  'device.disconnect': { en: 'Disconnect', zh: '断开' },
  'device.transport': { en: 'Transport', zh: '传输层' },
  'device.adapter': { en: 'Adapter', zh: '适配器' },
  'device.profile': { en: 'Profile', zh: 'Profile' },
  'device.assign': { en: 'Assign profile', zh: '指定 Profile' },
  'device.writes': { en: 'writes', zh: '写入' },
  'device.caps': { en: 'Capabilities', zh: '能力' },
  'device.capsKnown': { en: 'Known', zh: '已知' },
  'device.capsUnknown': { en: 'Unknown', zh: '未知' },
  'cap.supported': { en: 'supported', zh: '支持' },
  'cap.unsupported': { en: 'unsupported', zh: '不支持' },
  'cap.unknown': { en: 'unknown', zh: '未知' },
  'cap.read-only': { en: 'read-only', zh: '只读' },
  'cap.requires-user-profile': { en: 'requires user profile', zh: '需要用户指定' },
  'cap.requires-optional-extension': { en: 'requires optional extension', zh: '需要可选扩展' },
  'pending.title': { en: 'Pending operations', zh: '待执行操作' },
  'pending.empty': { en: 'No pending operations. Connect a device and enable an agent source.', zh: '没有待执行操作。请连接设备并启用 Agent 源。' },
  'pending.feasible': { en: 'feasible', zh: '可行' },
  'pending.blocked': { en: 'blocked', zh: '被拦截' },
  'audit.title': { en: 'Write audit', zh: '写入审计' },
  'audit.count': { en: 'Writes reaching devices: {n}', zh: '实际写入设备次数：{n}' },
  'audit.empty': { en: 'No write attempts recorded.', zh: '暂无写入记录。' },
  'audit.time': { en: 'Time', zh: '时间' },
  'audit.device': { en: 'Device', zh: '设备' },
  'audit.capability': { en: 'Capability', zh: '能力' },
  'audit.op': { en: 'Operation', zh: '操作' },
  'audit.result': { en: 'Result', zh: '结果' },
  'audit.wrote': { en: 'WROTE', zh: '已写入' },
  'audit.blocked': { en: 'blocked', zh: '已拦截' },
  'audit.ok': { en: 'ok', zh: '成功' },
  'settings.title': { en: 'Settings', zh: '设置' },
  'settings.language': { en: 'Language', zh: '界面语言' },
  'settings.langHint': { en: 'English is the default; your choice persists across restarts and upgrades.', zh: '默认英文；你的选择在重启和升级后保持。' },
  'settings.writepolicy': { en: 'Write policy', zh: '写入策略' },
  'settings.writepolicyHint': { en: 'Unknown devices always stay at zero writes regardless of this setting.', zh: '未知设备无论此设置如何都保持零写入。' },
  'settings.wp.read-only': { en: 'Read-only (default)', zh: '只读（默认）' },
  'settings.wp.ask': { en: 'Ask before writing', zh: '写入前询问' },
  'settings.wp.allow': { en: 'Allow writes (gated)', zh: '允许写入（仍需门禁）' },
  'settings.source': { en: 'Agent source', zh: 'Agent 状态来源' },
  'settings.config': { en: 'Config file', zh: '配置文件' },
  'settings.profiles': { en: 'Protocol profiles', zh: '协议 Profile' },
  'home.tagline': { en: 'Connect AI activity to capabilities already exposed by supported keyboard firmware.', zh: '把 AI 活动连接到受支持键盘固件已开放的能力上。' },
  'home.statusTitle': { en: 'Status', zh: '状态' },
  'home.noDevices': { en: 'No control devices. Plug in a QMK keyboard.', zh: '没有控制设备。请插入 QMK 键盘。' },
  'providers.title': { en: 'Agent Providers', zh: 'Agent Providers' },
  'providers.status': { en: 'Local API', zh: '本地 API' },
  'providers.addr': { en: 'Address', zh: '地址' },
  'providers.token': { en: 'Token', zh: 'Token' },
  'providers.start': { en: 'Start local API', zh: '启动本地 API' },
  'providers.test': { en: 'Test event', zh: '测试事件' },
  'providers.revoke': { en: 'Revoke token', zh: '撤销 token' },
  'providers.conflict': { en: 'Conflict policy', zh: '冲突策略' },
  'providers.pinned': { en: 'Pinned session', zh: '固定会话' },
  'providers.exampleTitle': { en: 'Local integration example', zh: '本地集成示例' },
  'providers.lastTitle': { en: 'Last event', zh: '最后事件' },
  'providers.copy': { en: 'Copy', zh: '复制' },
  'providers.running': { en: 'running', zh: '运行中' },
  'providers.stopped': { en: 'stopped', zh: '未运行' },
  'profiles.title': { en: 'Protocol Profiles', zh: '协议 Profiles' },
  'profiles.importTitle': { en: 'Import VIA definition (JSON)', zh: '导入 VIA definition (JSON)' },
  'profiles.import': { en: 'Import', zh: '导入' },
  'profiles.imported': { en: 'Imported OK — hash pinned.', zh: '导入成功——哈希已固定。' },
  'profiles.listTitle': { en: 'Profiles & bindings', zh: 'Profiles 与绑定' },
  'profiles.bind': { en: 'Bind to interface', zh: '绑定到接口' },
  'profiles.unbind': { en: 'Unbind', zh: '解除绑定' },
  'profiles.evidence': { en: 'evidence', zh: '证据' },
  'profiles.exportDiag': { en: 'Export diagnostics', zh: '导出诊断' },
  'profiles.verified': { en: 'verification', zh: '验证' },
  'profiles.risk': { en: 'risk', zh: '风险' },
  'profiles.bound': { en: 'bound', zh: '已绑定' },
  'compat.title': { en: 'Compatibility', zh: '兼容性' },
  'activity.events': { en: 'Recent events', zh: '最近事件' },
  'settings.master': { en: 'Disable all writes', zh: '禁用所有写入' },
  'settings.masterHint': { en: 'Master kill switch — ON by default. When ON, no write can reach any device.', zh: '总开关——默认开启。开启时任何设备都不允许写入。' },
  'settings.verified': { en: 'verification', zh: '验证' },
  'settings.risk': { en: 'risk', zh: '风险' },
  'agent.idle': { en: 'Idle', zh: '空闲' },
  'agent.thinking': { en: 'Thinking', zh: '思考中' },
  'agent.tool-running': { en: 'Running tool', zh: '执行工具' },
  'agent.waiting-for-approval': { en: 'Waiting for approval', zh: '等待批准' },
  'agent.waiting-for-user': { en: 'Waiting for user', zh: '等待用户' },
  'agent.done': { en: 'Done', zh: '完成' },
  'agent.error': { en: 'Error', zh: '错误' },
  'agent.disconnected': { en: 'Disconnected', zh: '断开' },
  'agent.simulated': { en: 'SIMULATED', zh: '模拟' },
  'agent.actions': { en: 'Actions', zh: '动作' },
  'action.approve': { en: 'Approve', zh: '批准' },
  'action.reject': { en: 'Reject', zh: '拒绝' },
  'action.new_task': { en: 'New task', zh: '新任务' },
  'action.send': { en: 'Send', zh: '发送' },
  'action.cancel': { en: 'Cancel', zh: '取消' },
  'status.ready': { en: 'ready', zh: '就绪' },
  'lights.title': { en: 'Status Lights', zh: '状态灯' },
  'lights.hint': { en: 'Configure which color each AI software shows on the keyboard for every agent state. Per-software settings override the global colors.', zh: '为每个 AI 软件配置键盘上各 Agent 状态对应的指示灯颜色。软件级设置覆盖全局颜色。' },
  'lights.source': { en: 'AI software', zh: 'AI 软件' },
  'lights.sourceHint': { en: 'Select a software to edit its status-light colors. Events from that software use these colors on the keyboard.', zh: '选择要编辑状态灯颜色的软件。来自该软件的事件会在键盘上使用这些颜色。' },
  'lights.states': { en: 'Agent state → keyboard light color', zh: 'Agent 状态 → 键盘灯颜色' },
  'lights.saved': { en: 'Saved.', zh: '已保存。' },
  'lights.agentState': { en: 'Agent state', zh: 'Agent 状态' },
  'lights.color': { en: 'Color', zh: '颜色' },
  'lights.useGlobal': { en: 'use global', zh: '使用全局' },
};

function t(key: string, vars?: Record<string, string | number>): string {
  const entry = DICT[key];
  let s = entry ? entry[locale] ?? entry.en : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

// ---- types mirroring the core API ----
interface DeviceView {
  id: string;
  label: string;
  status: string;
  transport?: string;
  adapterId?: string;
  profileId?: string | null;
  profileVersion?: string | null;
  capabilities: Record<string, string> | null;
  capabilitiesKnown: boolean;
  matchedProfiles: Array<{ profileId: string; matchedBy: string }>;
  error?: string;
  writeCount: number;
  iface: { path?: string; label: string; kind: string };
}

interface AiEvent {
  type: string;
  source: string;
  text?: string;
  session?: string;
  ts: number;
  confidence: number;
  simulated: boolean;
}

interface AuditEntry {
  id: number;
  ts: number;
  deviceId: string;
  capability?: string | null;
  opLabel?: string | null;
  wrote: boolean;
  allowed: boolean;
  reasons: string[];
  error?: string;
}

interface ProfileInfo {
  profileId: string;
  displayName: string;
  protocol: string;
  protocolVersion: string;
  verifiedStatus: string;
  riskLevel: string;
  sourceUrl: string;
}


// ---- app state ----
const state: {
  devices: DeviceView[];
  aiEvent: AiEvent | null;
  audit: AuditEntry[];
  profiles: ProfileInfo[];
  writeCount: number;
  writePolicy: string;
  settings: Record<string, unknown> | null;
  mapped: Map<string, Array<{ op: { kind: string; label: string }; feasible: boolean; reason: string }>>;
  pendingConfirmations: Array<{ token: string; summary: Record<string, unknown>; expiresAt: number }>;
  apiStatus: { running: boolean; host: string; port: number; tokenConfigured: boolean; tokenStorage: string; conflictPolicy: string } | null;
  apiToken: string;
  lastEvent: AiEvent | null;
  recentEvents: AiEvent[];
  writesDisabled: boolean;
  conflictPolicy: string;
} = {
  devices: [],
  aiEvent: null,
  audit: [],
  profiles: [],
  writeCount: 0,
  writePolicy: 'read-only',
  settings: null,
  mapped: new Map(),
  pendingConfirmations: [] as Array<{ token: string; summary: Record<string, unknown>; expiresAt: number }>,
  apiStatus: null as { running: boolean; host: string; port: number; tokenConfigured: boolean; tokenStorage: string; conflictPolicy: string } | null,
  apiToken: '',
  lastEvent: null as AiEvent | null,
  recentEvents: [] as AiEvent[],
  writesDisabled: true,
  conflictPolicy: 'priority',
};

const COLORS: Record<string, string> = {
  idle: '#ffffff', thinking: '#0078ff', 'tool-running': '#963cdc', 'waiting-for-approval': '#ff8c00',
  'waiting-for-user': '#00dcdc', done: '#00dc50', error: '#ff2828', disconnected: '#333333',
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

// ---- api access ----
const api = (window as unknown as { api: Record<string, (...a: unknown[]) => Promise<unknown> | unknown> }).api;

// ---- rendering ----
function renderAll(): void {
  renderNav();
  renderHome();
  renderDevices();
  renderLights();
  renderPending();
  renderAudit();
  renderActivityEvents();
  renderSettings();
  renderProviders();
  renderProfiles();
  renderCompat();
  renderTopbar();
}

function renderHome(): void {
  $('#home-title').textContent = t('app.title');
  $('#home-tagline').textContent = t('home.tagline');
  $('#home-status-title').textContent = t('home.statusTitle');
  const st = $('#home-status');
  const devCount = state.devices.length;
  st.innerHTML = `<span>Devices: <b>${devCount}</b></span>
    <span>Writes: <b>${state.writeCount}</b></span>
    <span>Write policy: <b>${esc(state.writePolicy)}</b></span>
    <span>Disable all writes: <b>${state.writesDisabled ? 'ON' : 'OFF'}</b></span>
    <span>Local API: <b>${state.apiStatus?.running ? t('providers.running') : t('providers.stopped')}</b></span>`;
  if (devCount === 0) {
    $('#home-hint').textContent = t('home.noDevices');
  } else {
    $('#home-hint').textContent = '';
  }
}

function renderProviders(): void {
  $('#providers-title').textContent = t('providers.title');
  $('#lbl-api-status').textContent = t('providers.status');
  $('#lbl-api-addr').textContent = t('providers.addr');
  $('#lbl-api-token').textContent = t('providers.token');
  $('#lbl-conflict').textContent = t('providers.conflict');
  $('#lbl-pinned').textContent = t('providers.pinned');
  $('#providers-example-title').textContent = t('providers.exampleTitle');
  $('#providers-last-title').textContent = t('providers.lastTitle');
  $('#btn-api-start').textContent = t('providers.start');
  $('#btn-api-test').textContent = t('providers.test');
  $('#btn-api-revoke').textContent = t('providers.revoke');
  $('#btn-copy-example').textContent = t('providers.copy');
  const status = state.apiStatus;
  $('#api-status').textContent = status?.running ? t('providers.running') : t('providers.stopped');
  $('#api-addr').textContent = status?.running ? `http://${status.host}:${status.port}` : '—';
  $('#api-token').textContent = state.apiToken ? `${state.apiToken.slice(0, 8)}…` : '—';
  ($('#set-conflict') as HTMLSelectElement).value = state.conflictPolicy;
  $('#providers-example').textContent = `# curl example
curl -X POST http://127.0.0.1:${status?.running ? status.port : '<port>'} \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt-1","providerId":"codex","sessionId":"s1","state":"thinking","toolName":"run tests"}'
# or use the bundled CLI: node examples/send-event.mjs <port> <token> thinking`;
  $('#providers-last').textContent = state.lastEvent
    ? `${state.lastEvent.source} / ${state.lastEvent.type}${state.lastEvent.text ? ' / ' + state.lastEvent.text : ''} @ ${new Date(state.lastEvent.ts).toLocaleTimeString()}`
    : '—';
}

function renderProfiles(): void {
  $('#profiles-title').textContent = t('profiles.title');
  $('#profiles-import-title').textContent = t('profiles.importTitle');
  $('#profiles-list-title').textContent = t('profiles.listTitle');
  $('#btn-def-import').textContent = t('profiles.import');
  $('#btn-export-diagnostics').textContent = t('profiles.exportDiag');
  const list = $('#profiles-list');
  if (state.profiles.length === 0) {
    list.innerHTML = `<p class="hint">—</p>`;
    return;
  }
  list.innerHTML = state.profiles
    .map((p) => {
      const def = (p as { definition?: { kind?: string; hash?: string } }).definition;
      const bound = (p as { boundTo?: string }).boundTo;
      return `<div class="profile-row">
        <b>${esc(p.displayName)}</b>
        <span class="hint">${esc(p.protocol)} v${esc(p.protocolVersion)}</span>
        <span>${t('profiles.verified')}: ${esc(p.verifiedStatus)}</span>
        <span>${t('profiles.risk')}: ${esc(p.riskLevel)}</span>
        ${def?.kind ? `<span>${esc(def.kind)}${def.hash ? ' · ' + esc(def.hash.slice(0, 8)) : ''}</span>` : ''}
        ${bound ? `<span class="ok-text">${t('profiles.bound')}</span>` : ''}
        ${p.sourceUrl ? `<a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">${t('profiles.evidence')}</a>` : ''}
      </div>`;
    })
    .join('');
}

function renderCompat(): void {
  $('#compat-title').textContent = t('compat.title');
  const list = $('#compat-list');
  const rows = state.profiles
    .map((p) => {
      const caps = Object.entries((p as { capabilities?: Record<string, string> }).capabilities ?? {})
        .filter(([, st]) => st === 'supported')
        .map(([c]) => c)
        .join(', ') || 'none';
      const hw = (p as { hardwareValidation?: { status?: string } }).hardwareValidation?.status ?? p.verifiedStatus;
      return `<div class="profile-row">
        <b>${esc(p.displayName)}</b>
        <span>supported: ${esc(caps)}</span>
        <span>hardware: <b>${esc(hw)}</b></span>
        <span>risk: ${esc(p.riskLevel)}</span>
      </div>`;
    })
    .join('');
  list.innerHTML = rows || '<p class="hint">—</p>';
}

function renderActivityEvents(): void {
  $('#activity-events-title').textContent = t('activity.events');
  const el = $('#activity-events');
  if (state.recentEvents.length === 0) {
    el.textContent = '—';
    return;
  }
  el.textContent = state.recentEvents
    .map((e) => `${new Date(e.ts).toLocaleTimeString()} [${e.source}] ${e.type}${e.text ? ' ' + e.text : ''}`)
    .join(String.fromCharCode(10));
}

function renderNav(): void {
  const map: Record<string, string> = {
    home: 'nav.home', devices: 'nav.devices', lights: 'nav.lights', mapping: 'nav.mapping', providers: 'nav.providers',
    profiles: 'nav.profiles', activity: 'nav.activity', settings: 'nav.settings', compat: 'nav.compat',
  };
  document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((b) => {
    const view = b.dataset.view ?? '';
    b.textContent = t(map[view] ?? view);
  });
}

function renderTopbar(): void {
  $('#app-title').textContent = t('app.title');
  $('#app-subtitle').textContent = t('app.subtitle');
  $('#btn-lang').textContent = t('btn.lang');
  const status = $('#status-text');
  status.textContent = t('status.ready');
}

const LIGHT_STATES = ['idle', 'thinking', 'tool-running', 'waiting-for-approval', 'waiting-for-user', 'done', 'error', 'disconnected'];

let lightsSelectedSource = '';

function lightsSources(): Array<{ id: string; label: string }> {
  const sources = (state.settings?.agentSources as Array<{ id: string; label?: string }> | undefined) ?? [];
  if (sources.length) return sources.map((s) => ({ id: s.id, label: s.label ?? s.id }));
  return [{ id: 'dsh', label: 'DeepSeek Harness' }, { id: 'codex', label: 'Codex' }, { id: 'claude', label: 'Claude Code' }, { id: 'virtual', label: 'Virtual Agent' }];
}

function lightsColorsFor(source: string): Record<string, string> {
  const lighting = (state.settings?.lighting as { stateColors?: Record<string, { r: number; g: number; b: number }>; perSourceColors?: Record<string, Record<string, { r: number; g: number; b: number }>> } | undefined) ?? {};
  const out: Record<string, string> = {};
  for (const s of LIGHT_STATES) {
    const override = lighting.perSourceColors?.[source]?.[s];
    const global = lighting.stateColors?.[s];
    const base = override ?? global ?? hexToRgb(COLORS[s] ?? '#ffffff');
    out[s] = rgbToHex(base);
  }
  return out;
}

function renderLights(): void {
  $('#lights-title').textContent = t('lights.title');
  $('#lights-hint').textContent = t('lights.hint');
  $('#lbl-lights-source').textContent = t('lights.source');
  $('#lights-source-hint').textContent = t('lights.sourceHint');
  $('#lights-states-title').textContent = t('lights.states');
  const sel = $('#lights-source') as HTMLSelectElement;
  const sources = lightsSources();
  if (!lightsSelectedSource || !sources.some((s) => s.id === lightsSelectedSource)) {
    lightsSelectedSource = sources[0]?.id ?? 'dsh';
  }
  sel.innerHTML = sources.map((s) => `<option value="${esc(s.id)}" ${s.id === lightsSelectedSource ? 'selected' : ''}>${esc(s.label ?? s.id)}</option>`).join('');
  const colors = lightsColorsFor(lightsSelectedSource);
  const box = $('#lights-states');
  box.innerHTML = LIGHT_STATES.map((s) => `<div class="light-row" data-state="${esc(s)}">
    <span class="light-state">${esc(t(`agent.${s}`))}</span>
    <input type="color" class="light-color" value="${esc(colors[s])}" />
    <span class="hint">${esc(colors[s])}</span>
  </div>`).join('');
}

function saveLights(source: string, colors: Record<string, string>): void {
  const lighting = (state.settings?.lighting as Record<string, unknown> | undefined) ?? {};
  const perSourceColors = (lighting.perSourceColors as Record<string, Record<string, { r: number; g: number; b: number }>> | undefined) ?? {};
  const next: Record<string, { r: number; g: number; b: number }> = {};
  for (const s of LIGHT_STATES) {
    next[s] = hexToRgb(colors[s]);
  }
  perSourceColors[source] = next;
  void (api.updateSettings as (p: Record<string, unknown>) => Promise<unknown>)({ lighting: { ...lighting, perSourceColors } }).then(() => {
    $('#lights-save-hint').textContent = t('lights.saved');
    setTimeout(() => { $('#lights-save-hint').textContent = ''; }, 1500);
  });
}

function renderDevices(): void {
  const list = $('#device-list');
  if (state.devices.length === 0) {
    list.innerHTML = `<div class="card empty">${t('devices.none')}</div>`;
    $('#readonly-hint').textContent = t('devices.readonlyDefault');
    return;
  }
  $('#readonly-hint').textContent = t('devices.readonlyDefault');
  list.innerHTML = '';
  for (const d of state.devices) {
    const el = document.createElement('div');
    el.className = 'device-card card';
    el.dataset.deviceId = d.id;
    el.innerHTML = deviceHtml(d);
    list.appendChild(el);
    bindDeviceActions(el, d);
  }
}

function deviceHtml(d: DeviceView): string {
  const statusLabel = t(`device.${d.status}`);
  const ifacePath = d.iface?.path ? `<code class="path">${esc(d.iface.path)}</code>` : '<span class="hint">no path</span>';
  const capsHtml = renderCaps(d);
  const readonlyNote =
    d.status === 'transport-available' && !d.capabilitiesKnown
      ? `<div class="banner readonly">${t('devices.readonlyBanner')}</div>`
      : '';
  return `
    <div class="device-head">
      <div>
        <div class="device-name">${esc(d.label)}</div>
        <div class="device-meta">
          <span class="badge st-${esc(d.status)}">${esc(statusLabel)}</span>
          <span>${esc(d.iface?.kind ?? '?')}</span>
          ${d.transport ? `<span>${t('device.transport')}: ${esc(d.transport)}</span>` : ''}
          ${d.adapterId ? `<span>${t('device.adapter')}: ${esc(d.adapterId)}</span>` : ''}
          <span>${t('device.writes')}: <b class="write-count">${d.writeCount}</b></span>
        </div>
      </div>
      <div class="device-actions">
        <button class="ghost btn-connect" data-action="connect">${t('device.connect')}</button>
        <button class="ghost btn-disconnect" data-action="disconnect" ${d.status === 'disconnected' ? 'disabled' : ''}>${t('device.disconnect')}</button>
      </div>
    </div>
    ${readonlyNote}
    <div class="device-detail">
      <div class="row"><label>${t('device.profile')}</label>${profileSelect(d)}</div>
      <div class="row"><label>${t('device.transport')}</label><span>${ifacePath}</span></div>
      ${d.error ? `<div class="row"><label>error</label><span class="err-text">${esc(d.error)}</span></div>` : ''}
    </div>
    ${capsHtml}
  `;
}

function profileSelect(d: DeviceView): string {
  const options = state.profiles
    .map((p) => `<option value="${p.profileId}" ${p.profileId === d.profileId ? 'selected' : ''}>${esc(p.displayName)}</option>`)
    .join('');
  return `<select class="profile-select" data-device="${esc(d.id)}">${options}</select>`;
}

function renderCaps(d: DeviceView): string {
  if (!d.capabilities) {
    return `<div class="caps"><div class="caps-title">${t('device.caps')} — ${t('device.capsUnknown')}</div></div>`;
  }
  const rows = Object.entries(d.capabilities)
    .map(([cap, st]) => `<tr><td>${esc(cap)}</td><td><span class="cap-state st-${esc(st)}">${esc(t(`cap.${st}`))}</span></td></tr>`)
    .join('');
  return `<div class="caps"><div class="caps-title">${t('device.caps')} — ${t('device.capsKnown')}</div>
    <table class="caps-table"><tbody>${rows}</tbody></table></div>`;
}

function bindDeviceActions(el: HTMLElement, d: DeviceView): void {
  el.querySelector<HTMLButtonElement>('.btn-connect')?.addEventListener('click', () => {
    const sel = el.querySelector<HTMLSelectElement>('.profile-select');
    const profileId = sel?.value || undefined;
    void (api.connectDevice as (id: string, p?: string) => Promise<unknown>)(d.id, profileId);
  });
  el.querySelector<HTMLButtonElement>('.btn-disconnect')?.addEventListener('click', () => {
    void (api.disconnectDevice as (id: string) => Promise<unknown>)(d.id);
  });
  el.querySelector<HTMLSelectElement>('.profile-select')?.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    const path = d.iface?.path;
    if (path) {
      void (api.assignProfile as (p: string, id: string) => Promise<unknown>)(path, target.value);
    }
  });
}

function renderConfirmations(): void {
  const list = $('#confirm-list');
  $('#confirm-title').textContent = t('confirm.title');
  if (state.pendingConfirmations.length === 0) {
    list.innerHTML = `<p class="hint">${t('confirm.empty')}</p>`;
    return;
  }
  list.innerHTML = '';
  for (const c of state.pendingConfirmations) {
    const s = c.summary;
    const el = document.createElement('div');
    el.className = 'confirm-card card';
    el.innerHTML = `
      <div class="row"><label>${t('confirm.device')}</label><span>${esc(String(s.deviceId ?? ''))}</span></div>
      <div class="row"><label>${t('confirm.interface')}</label><span>${esc(String(s.interfaceLabel ?? ''))}</span></div>
      <div class="row"><label>${t('confirm.transport')}</label><span>${esc(String(s.transport ?? ''))}</span></div>
      <div class="row"><label>${t('confirm.adapter')}</label><span>${esc(String(s.adapter ?? '—'))}</span></div>
      <div class="row"><label>${t('confirm.profile')}</label><span>${esc(String(s.profileId ?? '—'))}</span></div>
      <div class="row"><label>${t('confirm.capability')}</label><span>${esc(String(s.capability ?? ''))}</span></div>
      <div class="row"><label>${t('confirm.op')}</label><span>${esc(String(s.opLabel ?? ''))}</span></div>
      <div class="row"><label>${t('confirm.payload')}</label><code class="path">${esc(String(s.payloadHash ?? ''))}</code></div>
      <div class="row">
        <button class="primary btn-confirm" data-token="${esc(c.token)}">${t('confirm.approve')}</button>
      </div>`;
    el.querySelector<HTMLButtonElement>('.btn-confirm')?.addEventListener('click', () => {
      void (api.confirmOp as (token: string) => Promise<unknown>)(c.token).then(() => void refreshAll());
    });
    list.appendChild(el);
  }
}

function renderPending(): void {
  const list = $('#pending-list');
  if (state.devices.length === 0) {
    list.innerHTML = `<p class="hint">${t('pending.empty')}</p>`;
    renderConfirmations();
    return;
  }
  let html = '';
  for (const d of state.devices) {
    const ops = state.mapped.get(d.id) ?? [];
    html += `<div class="pending-device"><b>${esc(d.label)}</b>`;
    if (ops.length === 0) {
      html += `<p class="hint">${t('pending.empty')}</p>`;
    } else {
      html += '<ul class="pending-ops">' + ops
        .map((m) => `<li><span class="${m.feasible ? 'ok-text' : 'blocked-text'}">${m.feasible ? t('pending.feasible') : t('pending.blocked')}</span> ${esc(m.op.label)} <span class="hint">(${esc(m.reason)})</span></li>`)
        .join('') + '</ul>';
    }
    html += '</div>';
  }
  list.innerHTML = html;
  renderConfirmations();
}

function renderAudit(): void {
  $('#audit-count').textContent = t('audit.count', { n: state.writeCount });
  const body = $('#audit-body');
  if (state.audit.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="hint">${t('audit.empty')}</td></tr>`;
    return;
  }
  body.innerHTML = state.audit
    .map((a) => {
      const when = new Date(a.ts).toLocaleTimeString();
      const result = a.wrote
        ? `<span class="ok-text">${t('audit.wrote')}</span>`
        : `<span class="blocked-text">${t('audit.blocked')}</span>`;
      const reasons = a.reasons.length ? `<div class="hint">${esc(a.reasons.join('; '))}</div>` : '';
      return `<tr>
        <td>${when}</td>
        <td>${esc(a.deviceId)}</td>
        <td>${esc(a.capability ?? '—')}</td>
        <td>${esc(a.opLabel ?? '—')}${reasons}</td>
        <td>${result}</td>
      </tr>`;
    })
    .join('');
}

function renderSettings(): void {
  $('#lang-hint').textContent = t('settings.langHint');
  $('#writepolicy-hint').textContent = t('settings.writepolicyHint');
  const lang = $('#set-language') as HTMLSelectElement;
  lang.value = locale;
  const wp = $('#set-writepolicy') as HTMLSelectElement;
  wp.value = state.writePolicy;
  const master = $('#set-masterwrite') as HTMLInputElement;
  master.checked = state.writesDisabled;
  $('#lbl-master').textContent = t('settings.master');
  $('#writepolicy-hint').textContent = t('settings.writepolicyHint') + ' ' + t('settings.masterHint');
  const sources = (state.settings?.agentSources as Array<{ id: string; label?: string; enabled?: boolean }> | undefined) ?? [];
  const src = $('#set-source') as HTMLSelectElement;
  src.innerHTML = sources
    .map((s) => `<option value="${esc(s.id)}">${esc(s.label ?? s.id)}${s.enabled ? '' : ' (off)'}</option>`)
    .join('');
  const profiles = $('#profiles-list');
  profiles.innerHTML = state.profiles
    .map(
      (p) => `<div class="profile-row">
        <b>${esc(p.displayName)}</b>
        <span class="hint">${esc(p.protocol)} v${esc(p.protocolVersion)}</span>
        <span>${t('settings.verified')}: ${esc(p.verifiedStatus)}</span>
        <span>${t('settings.risk')}: ${esc(p.riskLevel)}</span>
        <a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">src</a>
      </div>`,
    )
    .join('');
}

function renderAgent(): void {
  const ev = state.aiEvent;
  const dot = $('#agent-dot');
  const st = $('#agent-state');
  const badge = $('#agent-badge');
  const text = $('#agent-text');
  const meta = $('#agent-source');
  const session = $('#agent-session');
  const conf = $('#agent-conf');
  const bar = $('#agent-progress-bar');
  if (!ev) {
    dot.style.background = '#333';
    st.textContent = t('agent.idle');
    badge.classList.add('hidden');
    text.textContent = '—';
    meta.textContent = 'source: —';
    session.textContent = 'session: —';
    conf.textContent = '';
    bar.style.width = '0%';
    return;
  }
  dot.style.background = COLORS[ev.type] ?? '#fff';
  st.textContent = t(`agent.${ev.type}`);
  badge.classList.toggle('hidden', !ev.simulated);
  text.textContent = ev.text ?? '—';
  meta.textContent = `source: ${ev.source}`;
  session.textContent = `session: ${ev.session ?? '—'}`;
  conf.textContent = ev.simulated ? t('agent.simulated') : `confidence ${Math.round(ev.confidence * 100)}%`;
  bar.style.width = '0%';
}

function renderActionGrid(): void {
  const grid = $('#action-grid');
  const actions = ['approve', 'reject', 'new_task', 'send', 'cancel'];
  grid.innerHTML = `<div class="grid-title">${t('agent.actions')}</div>` +
    actions.map((a) => `<button class="action-btn" data-action="${a}">${t(`action.${a}`)}</button>`).join('');
  grid.querySelectorAll<HTMLButtonElement>('.action-btn').forEach((b) => {
    b.addEventListener('click', () => void (api.triggerAction as (a: string) => Promise<unknown>)(b.dataset.action ?? ''));
  });
}

// ---- event wiring ----
function onEvent(ev: Record<string, unknown>): void {
  switch (ev.type) {
    case 'devices':
      state.devices = (ev.devices as DeviceView[]) ?? [];
      renderDevices();
      renderPending();
      break;
    case 'deviceStatus': {
      const d = ev.device as DeviceView;
      const idx = state.devices.findIndex((x) => x.id === d.id);
      if (idx >= 0) state.devices[idx] = d;
      else state.devices.push(d);
      renderDevices();
      renderPending();
      break;
    }
    case 'aiEvent': {
      const e = ev.ev as AiEvent;
      state.aiEvent = e;
      state.lastEvent = e;
      state.recentEvents = [e, ...state.recentEvents].slice(0, 50);
      renderAgent();
      renderActivityEvents();
      renderProviders();
      break;
    }
    case 'mapped': {
      const ops = (ev.ops as Array<{ op: { kind: string; label: string }; feasible: boolean; reason: string }>) ?? [];
      state.mapped.set(ev.deviceId as string, ops);
      renderPending();
      void (api.pendingConfirmations as () => Promise<Array<{ token: string; summary: Record<string, unknown>; expiresAt: number }>>)().then((list) => {
        state.pendingConfirmations = list ?? [];
        renderConfirmations();
      });
      break;
    }
    case 'log':
      $('#log-line').textContent = String(ev.msg ?? '');
      break;
    case 'settings':
      state.settings = ev.settings as Record<string, unknown>;
      {
        const l = state.settings.locale as string | undefined;
        if (l === 'zh' || l === 'en') locale = l;
      }
      renderAll();
      break;
  }
}

async function refreshAll(): Promise<void> {
  state.devices = ((await (api.listDevices as () => Promise<DeviceView[]>)()) as DeviceView[]) ?? [];
  state.profiles = ((await (api.listProfiles as () => Promise<ProfileInfo[]>)()) as ProfileInfo[]) ?? [];
  state.audit = ((await (api.recentAudit as () => Promise<AuditEntry[]>)()) as AuditEntry[]) ?? [];
  state.writeCount = Number((await (api.writeCount as () => Promise<unknown>))() ?? 0);
  state.writePolicy = String((await (api.getWritePolicy as () => Promise<unknown>))() ?? 'read-only');
  const settings = (await (api.getSettings as () => Promise<Record<string, unknown> | null>)()) as Record<string, unknown> | null;
  if (settings) {
    state.settings = settings;
    locale = settings.locale === 'zh' ? 'zh' : 'en';
  }
  state.pendingConfirmations = ((await (api.pendingConfirmations as () => Promise<Array<{ token: string; summary: Record<string, unknown>; expiresAt: number }>>)()) as Array<{ token: string; summary: Record<string, unknown>; expiresAt: number }>) ?? [];
  state.apiStatus = (await (api.apiStatus as () => Promise<{ running: boolean; host: string; port: number; tokenConfigured: boolean; tokenStorage: string; conflictPolicy: string } | null>)()) as typeof state.apiStatus;
  state.apiToken = String((await (api.apiToken as () => Promise<unknown>))() ?? '');
  state.writesDisabled = Boolean((await (api.getWritesDisabled as () => Promise<unknown>))() ?? true);
  state.conflictPolicy = String(state.apiStatus?.conflictPolicy ?? 'priority');
  renderAll();
}

function setupEvents(): void {
  $('#btn-lang').addEventListener('click', () => {
    locale = locale === 'en' ? 'zh' : 'en';
    void (api.setLocale as (l: string) => Promise<unknown>)(locale);
    renderAll();
  });
  $('#btn-refresh').addEventListener('click', () => void refreshAll());
  $('#set-language').addEventListener('change', (e) => {
    locale = (e.target as HTMLSelectElement).value as Locale;
    void (api.setLocale as (l: string) => Promise<unknown>)(locale);
    renderAll();
  });
  $('#set-writepolicy').addEventListener('change', (e) => {
    void (api.setWritePolicy as (p: string) => Promise<unknown>)((e.target as HTMLSelectElement).value);
  });
  $('#set-masterwrite').addEventListener('change', (e) => {
    const v = (e.target as HTMLInputElement).checked;
    void (api.setWritesDisabled as (v: boolean) => Promise<unknown>)(v).then(() => void refreshAll());
  });
  $('#btn-api-start').addEventListener('click', () => {
    void (api.startLocalApi as (cfg?: unknown) => Promise<unknown>)({}).then(() => void refreshAll());
  });
  $('#btn-api-test').addEventListener('click', () => {
    void (api.apiTestEvent as () => Promise<unknown>)().then(() => void refreshAll());
  });
  $('#btn-api-revoke').addEventListener('click', () => {
    void (api.apiRevokeToken as () => Promise<unknown>)().then(() => void refreshAll());
  });
  $('#set-conflict').addEventListener('change', (e) => {
    state.conflictPolicy = (e.target as HTMLSelectElement).value;
    const pinned = ($('#set-pinned') as HTMLInputElement).value || undefined;
    void (api.apiSetConflictPolicy as (p: string, pinned?: string) => Promise<unknown>)(state.conflictPolicy, pinned);
  });
  $('#btn-copy-example').addEventListener('click', async () => {
    const text = ($('#providers-example') as HTMLElement).textContent ?? '';
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  });
  $('#btn-def-import').addEventListener('click', async () => {
    const raw = ($('#def-import') as HTMLTextAreaElement).value;
    const res = (await (api.importDefinition as (raw: string) => Promise<{ ok: boolean; profileId?: string; errors: string[]; warnings: string[]; preview?: unknown }>)(raw)) as { ok: boolean; profileId?: string; errors: string[]; warnings: string[]; preview?: unknown };
    const out = $('#def-import-result');
    const prev = $('#def-preview');
    if (res.ok) {
      out.textContent = t('profiles.imported');
      out.className = 'ok-text';
      prev.textContent = JSON.stringify(res.preview ?? {}, null, 2);
    } else {
      out.textContent = res.errors.join('; ');
      out.className = 'err-text';
      prev.textContent = '';
    }
    void refreshAll();
  });
  $('#btn-export-diagnostics').addEventListener('click', async () => {
    const diag = (await (api.exportDiagnostics as () => Promise<unknown>)( )) as Record<string, unknown>;
    const el = $('#diagnostics-out');
    el.textContent = JSON.stringify(diag, null, 2);
    el.classList.remove('hidden');
  });
  $('#set-source').addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    const sources = (state.settings?.agentSources as Array<{ id: string }> | undefined) ?? [];
    void (api.updateSettings as (p: Record<string, unknown>) => Promise<unknown>)({ activeAgentSource: id, agentSources: sources });
  });
  $('#lights-source').addEventListener('change', (e) => {
    lightsSelectedSource = (e.target as HTMLSelectElement).value;
    renderLights();
  });
  $('#lights-states').addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (!target.classList.contains('light-color')) return;
    const row = target.closest<HTMLElement>('.light-row');
    const state = row?.dataset.state ?? '';
    const colors = lightsColorsFor(lightsSelectedSource);
    colors[state] = target.value;
    saveLights(lightsSelectedSource, colors);
    const hint = row?.querySelector<HTMLElement>('.hint');
    if (hint) hint.textContent = target.value;
  });
  document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.remove('active'));
      document.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((n) => n.classList.remove('active'));
      b.classList.add('active');
      const view = b.dataset.view ?? 'agent';
      $(`#view-${view}`).classList.add('active');
    });
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

// ---- boot ----
(async function boot(): Promise<void> {
  (api.onEvent as (cb: (e: unknown) => void) => () => void)((e) => onEvent(e as Record<string, unknown>));
  setupEvents();
  await refreshAll();
  renderAll();
})();
