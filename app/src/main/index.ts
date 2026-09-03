/**
 * Main process (round-15) — window + ConsoleCore wiring + IPC + simulator
 * hosting + real HID transport. The layered pipeline lives in core; this file
 * only injects platform transports and exposes the IPC surface.
 */

import { app, BrowserWindow, ipcMain, globalShortcut } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  ConsoleCore, type CoreEvent, type DeviceView, type DeviceConfig,
} from '@vibebridge/core';
import { VirtualKeyboardServer, VirtualAgentServer, type VirtualKeyboardMode } from '@vibebridge/simulator';
import { hidIntegration } from './hid';

const isolatedUserData = process.env.AI_CONSOLE_USER_DATA;
if (isolatedUserData) {
  app.setPath('userData', isolatedUserData);
}
const debugFilePath = isolatedUserData ? path.join(isolatedUserData, 'main-debug.log') : null;
const _debugFile = (msg: string): void => {
  if (!debugFilePath) return;
  try {
    fs.appendFileSync(debugFilePath, `${Date.now()} ${msg}\n`);
  } catch { /* ignore */ }
};
const isSmoke = process.argv.includes('--smoke-test');
const isUiSmoke = process.argv.includes('--ui-smoke-test');
const isTestMode = isSmoke || isUiSmoke;
const isPrimaryInstance = isTestMode || app.requestSingleInstanceLock();
_debugFile(`lock acquired=${isPrimaryInstance} mode=${isTestMode ? 'test' : 'gui'}`);
if (isPrimaryInstance && isolatedUserData) {
  try {
    fs.writeFileSync(path.join(isolatedUserData, 'main.pid'), String(process.pid));
  } catch { /* ignore */ }
}
if (!isPrimaryInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    _debugFile('second-instance event');
    log('info', 'second-instance: focusing main window');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
const openDevTools = process.env.AI_CONSOLE_DEVTOOLS === '1' || process.argv.includes('--devtools');

let core: ConsoleCore | null = null;
let mainWindow: BrowserWindow | null = null;
let virtualKb: VirtualKeyboardServer | null = null;
let virtualAgent: VirtualAgentServer | null = null;
let simulatorPorts = { kb: 0, agent: 0 };

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  console.log(`[${level}] ${msg}`);
  core?.emit('log' as never, { type: 'log', level, msg } as CoreEvent);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'Vibe Bridge',
    backgroundColor: '#101318',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (openDevTools) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function push(event: CoreEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('core-event', event);
  }
}

function setupCore(): void {
  const settingsPath = process.env.AI_CONSOLE_CONFIG ?? undefined;
  const hid = hidIntegration();
  core = new ConsoleCore({
    settingsPath,
    onLog: log,
    enumerateInterfaces: hid.enumerateInterfaces,
    openTransport: hid.openTransport,
  });
  core.on('log' as never, (e: CoreEvent) => push(e));
  core.on('devices' as never, (e: CoreEvent) => push(e));
  core.on('deviceStatus' as never, (e: CoreEvent) => push(e));
  core.on('aiEvent' as never, (e: CoreEvent) => push(e));
  core.on('mapped' as never, (e: CoreEvent) => push(e));
  core.on('settings' as never, (e: CoreEvent) => push(e));
}

async function startSimulator(mode?: string): Promise<void> {
  const kbMode: VirtualKeyboardMode = (mode as VirtualKeyboardMode) ?? 'akp';
  if (virtualKb && virtualAgent) {
    pushSimState();
    return;
  }
  const cfg = core!.settings.get();
  const kbPort = cfg.devices.find((d) => d.id === 'vk-sim')?.port ?? 0;
  const agentPort = cfg.agentSources.find((s) => s.id === 'virtual')?.port ?? 0;
  virtualKb = new VirtualKeyboardServer({ port: kbPort, mode: kbMode, onLog: log });
  virtualAgent = new VirtualAgentServer({ port: agentPort, onLog: log });
  simulatorPorts.kb = await virtualKb.start();
  simulatorPorts.agent = await virtualAgent.start();
  core!.updateSettings({
    devices: core!.settings.get().devices.map((d) => (d.id === 'vk-sim' ? { ...d, port: simulatorPorts.kb } : d)),
    agentSources: core!.settings.get().agentSources.map((s) =>
      s.id === 'virtual' ? { ...s, port: simulatorPorts.agent, enabled: true } : s,
    ),
  });
  log('info', `simulator started (kb=:${simulatorPorts.kb} agent=:${simulatorPorts.agent} mode=${kbMode})`);
  // register + connect the virtual device through the round-15 path
  if (!core!.devices.get('vk-sim')) {
    await core!.addSimulatorDevice({
      id: 'vk-sim',
      label: `Virtual Keyboard (${kbMode})`,
      kind: 'virtual',
      host: '127.0.0.1',
      port: simulatorPorts.kb,
      mtu: 32,
      enabled: true,
    });
    const path = `tcp://127.0.0.1:${simulatorPorts.kb}`;
    core!.assignProfile(path, kbMode === 'akp' ? 'akp-extension' : kbMode === 'simulator' ? 'simulator' : kbMode);
    await core!.connectDevice('vk-sim', kbMode === 'akp' ? 'akp-extension' : kbMode);
  }
  push({ type: 'settings', settings: core!.settings.get() });
}

async function stopSimulator(): Promise<void> {
  if (core) {
    core.devices.remove('vk-sim');
    core.updateSettings({ devices: core.settings.get().devices.filter((d) => d.id !== 'vk-sim') });
    const hasVirtual = core.settings.get().agentSources.some((s) => s.id === 'virtual' && s.enabled);
    if (hasVirtual) {
      core.updateSettings({
        agentSources: core.settings.get().agentSources.map((s) => (s.id === 'virtual' ? { ...s, enabled: false } : s)),
      });
    }
  }
  if (virtualKb) await virtualKb.stop();
  if (virtualAgent) await virtualAgent.stop();
  virtualKb = null;
  virtualAgent = null;
  log('info', 'simulator stopped');
  pushSimState();
  if (core) push({ type: 'settings', settings: core.settings.get() });
}

function pushSimState(): void {
  push({ type: 'log', level: 'info', msg: `simulator ${virtualKb && virtualAgent ? 'running' : 'stopped'}` } as never);
}

function setupIpc(): void {
  ipcMain.handle('core:get-settings', () => core?.settings.get() ?? null);
  ipcMain.handle('core:update-settings', (_e, patch) => core?.updateSettings(patch) ?? null);
  ipcMain.handle('core:set-locale', (_e, locale: string) => core?.setLocale(locale === 'zh' ? 'zh' : 'en'));
  ipcMain.handle('core:list-devices', () => core?.listDevices() ?? []);
  ipcMain.handle('core:refresh-devices', () => core?.refreshDevices() ?? []);
  ipcMain.handle('core:connect-device', (_e, id: string, profileId?: string) => core?.connectDevice(id, profileId) ?? null);
  ipcMain.handle('core:disconnect-device', (_e, id: string) => core?.disconnectDevice(id));
  ipcMain.handle('core:assign-profile', (_e, interfacePath: string, profileId: string) => core?.assignProfile(interfacePath, profileId));
  ipcMain.handle('core:list-profiles', () => core?.listProfiles() ?? []);
  ipcMain.handle('core:device-write-enabled', (_e, id: string, enabled: boolean) => core?.setDeviceWriteEnabled(id, enabled));
  ipcMain.handle('core:write-policy', (_e, policy: string) => core?.setWritePolicy(policy === 'allow' ? 'allow' : policy === 'ask' ? 'ask' : 'read-only'));
  ipcMain.handle('core:get-write-policy', () => core?.getWritePolicy() ?? 'read-only');
  ipcMain.handle('core:writes-disabled', (_e, v: boolean) => core?.setWritesDisabled(!!v));
  ipcMain.handle('core:get-writes-disabled', () => core?.getWritesDisabled() ?? true);
  ipcMain.handle('core:import-definition', (_e, raw: string) => core?.importViaDefinition(raw) ?? { ok: false, errors: ['no core'], warnings: [] });
  ipcMain.handle('core:bind-definition', (_e, ifacePath: string, profileId: string) => core?.bindDefinition(ifacePath, profileId) ?? { ok: false, error: 'no core' });
  ipcMain.handle('core:unbind-profile', (_e, ifacePath: string) => core?.unbindProfile(ifacePath));
  ipcMain.handle('core:export-diagnostics', () => core?.exportDiagnostics() ?? {});
  ipcMain.handle('core:set-show-all', (_e, v: boolean) => core?.setShowAllInterfaces(!!v));
  ipcMain.handle('core:audit', () => core?.recentAudit(100) ?? []);
  ipcMain.handle('core:write-count', () => core?.writeCount() ?? 0);
  ipcMain.handle('core:trigger-action', (_e, action: string) => core?.triggerAction(action) ?? null);
  ipcMain.handle('core:trigger-op', (_e, op) => core?.triggerOp(op) ?? { ok: false, error: 'no core' });
  ipcMain.handle('core:confirm-op', (_e, token: string, op?: unknown) => core?.confirmOp(token, op as never) ?? { ok: false, error: 'no core' });
  ipcMain.handle('core:pending-confirmations', () => core?.pendingConfirmations() ?? []);
  ipcMain.handle('sim:start', async (_e, mode?: string) => {
    await startSimulator(mode);
    return { running: !!(virtualKb && virtualAgent) };
  });
  ipcMain.handle('sim:stop', async () => {
    await stopSimulator();
    return { running: false };
  });
  ipcMain.handle('sim:status', () => ({ running: !!(virtualKb && virtualAgent) }));
  ipcMain.handle('app:config-path', () => core?.settings.path ?? '');
  ipcMain.handle('api:start', async (_e, cfg?: unknown) => core?.startLocalApi(cfg as never) ?? null);
  ipcMain.handle('api:stop', async () => core?.stopLocalApi());
  ipcMain.handle('api:status', () => core?.getLocalApiStatus() ?? null);
  ipcMain.handle('api:token', () => core?.getLocalApiToken() ?? '');
  ipcMain.handle('api:revoke-token', () => core?.revokeLocalApiToken());
  ipcMain.handle('api:conflict-policy', (_e, p: string, pinned?: string) => core?.setConflictPolicy(p as never, pinned));
  ipcMain.handle('api:test', async () => {
    if (core) {
      const status = core.getLocalApiStatus();
      if (status?.running) {
        // emit a test event directly through the server path
        return core.ingestAgentEvent({ eventId: `test-${Date.now()}`, providerId: 'local-api-test', sessionId: 'test', state: 'thinking', toolName: 'test event' });
      }
      return { code: 503, error: 'local API not running' };
    }
    return { code: 503, error: 'no core' };
  });
}

/** Headless acceptance smoke (round-15): unknown Raw HID zero-write, AKP
 *  optional adapter, VIA identification, ZMK Studio framing + lock. */
async function smokeTest(): Promise<void> {
  const errors: string[] = [];
  const errorLog = (level: 'info' | 'warn' | 'error', msg: string) => {
    log(level, msg);
    if (level === 'error') errors.push(msg);
  };
  const results: Record<string, unknown> = {};
  try {
    log('info', 'SMOKE TEST START');
    const tmpDir = fs.mkdtempSync('/tmp/vibebridge-smoke-');
    const settingsPath = path.join(tmpDir, 'config.json');

    // helper: run a scenario against a virtual keyboard mode with a fresh core
    async function scenario(
      label: string,
      mode: VirtualKeyboardMode,
      profileId: string | undefined,
      setup?: (c: ConsoleCore) => Promise<void>,
      writePolicy = 'read-only',
    ): Promise<{ c: ConsoleCore; kb: VirtualKeyboardServer }> {
      const kb = new VirtualKeyboardServer({ port: 0, mode, onLog: errorLog });
      const agent = new VirtualAgentServer({ port: 0, auto: false, thinkingMs: 60, toolMs: 40, continueMs: 40, onLog: errorLog });
      const kbPort = await kb.start();
      const agentPort = await agent.start();
      const cfgPath = path.join(tmpDir, `cfg-${label}.json`);
      fs.writeFileSync(cfgPath, JSON.stringify({
        agentSources: [
          { id: 'virtual', kind: 'virtual', label: 'Virtual Agent', enabled: true, host: '127.0.0.1', port: agentPort },
          { id: 'dsh', kind: 'dsh', label: 'DSH', enabled: false },
          { id: 'codex', kind: 'codex', label: 'Codex', enabled: false },
          { id: 'claude', kind: 'claude', label: 'Claude', enabled: false },
        ],
        activeAgentSource: 'virtual',
        executor: 'off',
        writePolicy,
        devices: [],
      }));
      const c = new ConsoleCore({ settingsPath: cfgPath, onLog: errorLog });
      await c.start();
      // register the virtual keyboard through the core
      await c.addSimulatorDevice({
        id: 'vk', label: 'Virtual KB', kind: 'virtual', host: '127.0.0.1', port: kbPort, mtu: 32, enabled: true,
      });
      if (profileId) {
        c.assignProfile(`tcp://127.0.0.1:${kbPort}`, profileId);
        await c.connectDevice('vk', profileId);
      }
      await setup?.(c);
      await sleep(400);
      return { c, kb };
    }

    // ---- 1. unknown Raw HID: transport-available, capabilities unknown, ZERO writes ----
    {
      const { c } = await scenario('unknown-rawhid', 'unknown-rawhid', undefined);
      const dev = c.devices.get('vk');
      results.unknown_status = dev?.status;
      results.unknown_capsKnown = dev?.capabilitiesKnown;
      results.unknown_zeroWrites = c.writeCount() === 0;
      results.unknown_notIncompatible = dev?.status !== 'unsupported';
      // pump AI events through the mapping pipeline — nothing may be written
      const ev = { type: 'thinking' as const, source: 'virtual', ts: Date.now(), confidence: 1, simulated: true };
      await c['dispatchAiEvent'](ev);
      await sleep(200);
      results.unknown_zeroWritesAfterEvent = c.writeCount() === 0;
      await c.stop();
    }

    // ---- 2. AKP as optional adapter: independent handshake ----
    {
      const { c } = await scenario('akp', 'akp', 'akp-extension');
      const dev = c.devices.get('vk');
      results.akp_status = dev?.status;
      results.akp_profile = dev?.profileId;
      results.akp_capsKnown = dev?.capabilitiesKnown;
      results.akp_zeroWritesDuringIdentify = c.writeCount() === 0; // identify is read-only
      await c.stop();
    }

    // ---- 3. VIA identification ----
    {
      const { c } = await scenario('via', 'via', 'via');
      const dev = c.devices.get('vk');
      results.via_status = dev?.status;
      results.via_version = dev?.profileVersion;
      results.via_identified = dev?.adapterId === 'via';
      await c.stop();
    }

    // ---- 4. ZMK Studio framing + lock handling ----
    {
      const { c, kb } = await scenario('zmk-studio', 'zmk-studio', 'zmk-studio', undefined, 'allow');
      c.setWritesDisabled(false); // user turns the master kill switch off
      c.setDeviceWriteEnabled('vk', true);
      const dev = c.devices.get('vk');
      results.studio_status = dev?.status;
      results.studio_identified = dev?.adapterId === 'zmk-studio';
      // runtime-keymap while locked: blocked with zero writes (round-16 P1-1)
      const op = { kind: 'runtime-keymap' as const, deviceId: 'vk', label: 'get keymap', payload: { action: 'get-keymap' } };
      const r = await c.triggerOp(op);
      results.studio_keymapBlockedWhenLocked = r.ok === false;
      results.studio_writesAfterIdentify = c.writeCount();
      // unlock request: ZERO writes, no fake success (core.proto has no unlock RPC)
      const unlock = await c.triggerOp({ kind: 'runtime-keymap' as const, deviceId: 'vk', label: 'unlock', payload: { action: 'unlock' } });
      results.studio_unlockZeroWrites = unlock.ok === false && c.writeCount() === results.studio_writesAfterIdentify;
      // physical unlock on the keyboard -> lock_state_changed -> keymap works
      results.studio_physicalUnlock = kb.simulatePhysicalUnlock();
      await sleep(300);
      const after = await c.triggerOp(op);
      results.studio_keymapAfterPhysicalUnlock = after.ok === true;
      await c.stop();
    }

    // ---- 5. default locale English ----
    {
      const { c } = await scenario('locale', 'akp', 'akp-extension');
      results.defaultLocale = c.settings.get().locale;
      c.setLocale('zh');
      results.zhPersisted = c.settings.get().locale === 'zh';
      const p = c.settings.path;
      results.zhPersistedFile = fs.readFileSync(p, 'utf8').includes('"locale": "zh"');
      const c2 = new ConsoleCore({ settingsPath: p, onLog: errorLog });
      results.zhSurvivesRestart = c2.settings.get().locale === 'zh';
      await c2.stop();
      await c.stop();
    }

    const INFO_KEYS = new Set([
      'unknown_status', 'unknown_capsKnown', 'akp_status', 'akp_profile', 'akp_capsKnown',
      'via_status', 'via_version', 'studio_status', 'studio_writesAfterIdentify', 'noErrors',
      'defaultLocale', 'studio_physicalUnlock',
    ]);
    results.noErrors = errors.length === 0;
    results.ok = Object.entries(results)
      .filter(([k]) => !INFO_KEYS.has(k))
      .every(([, v]) => v === true);
    console.log('SMOKE_RESULT ' + JSON.stringify(results));
    log('info', 'SMOKE TEST END');
    app.exit(results.ok ? 0 : 1);
  } catch (err) {
    console.error('SMOKE_FATAL ' + ((err as Error).stack ?? String(err)));
    app.exit(1);
  }
}

/** Real-UI smoke: loads the actual renderer, drives IPC, asserts DOM. */
async function uiSmokeTest(): Promise<void> {
  const errors: string[] = [];
  const errorLog: typeof log = (level, msg) => {
    log(level, msg);
    if (level === 'error') errors.push(msg);
  };
  const results: Record<string, unknown> = {};

  try {
    setupIpc();
    const win = new BrowserWindow({
      show: false,
      width: 980,
      height: 660,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 3) errors.push(message);
    });
    mainWindow = win;

    async function launchUi(config: Record<string, unknown>) {
      const tmpDir = fs.mkdtempSync('/tmp/vibebridge-ui-smoke-');
      const settingsPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(settingsPath, JSON.stringify(config));
      const hid = hidIntegration();
      const c = new ConsoleCore({ settingsPath, onLog: errorLog, enumerateInterfaces: hid.enumerateInterfaces, openTransport: hid.openTransport });
      c.on('log' as never, (e: CoreEvent) => push(e));
      c.on('devices' as never, (e: CoreEvent) => push(e));
      c.on('deviceStatus' as never, (e: CoreEvent) => push(e));
      c.on('aiEvent' as never, (e: CoreEvent) => push(e));
      c.on('mapped' as never, (e: CoreEvent) => push(e));
      c.on('settings' as never, (e: CoreEvent) => push(e));
      core = c;
      await c.start();
      await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
      const js = (script: string) => win.webContents.executeJavaScript(script, true) as Promise<unknown>;
      return { js, settingsPath, stop: async () => { await c.stop(); } };
    }

    // scenario A: fresh config -> English default
    {
      const { js, settingsPath, stop } = await launchUi({
        agentSources: [
          { id: 'virtual', kind: 'virtual', label: 'Virtual Agent', enabled: false, host: '127.0.0.1', port: 0 },
          { id: 'dsh', kind: 'dsh', label: 'DSH', enabled: false },
        ],
        activeAgentSource: 'virtual',
        executor: 'off',
        devices: [],
      });
      await sleep(1500);
      results.a_navDevicesEnglish = await js(`document.querySelector('[data-view="devices"]')?.textContent === 'Devices'`);
      results.a_readonlyBannerEnglish = await js(`(document.querySelector('.banner.readonly')?.textContent ?? '').includes('QMK Raw HID transport found. No verified control profile is selected. The device will remain read-only.')`);
      results.a_noChineseLeftover = await js(`!document.body.innerText.includes('设备')`);
      await js(`window.api.setLocale('zh').then(() => true)`);
      await sleep(600);
      results.a_zhNav = await js(`document.querySelector('[data-view="devices"]')?.textContent === '设备'`);
      results.a_zhPersisted = fs.readFileSync(settingsPath, 'utf8').includes('"locale": "zh"');
      await stop();
      results.settingsPathA = settingsPath;
    }

    // scenario B: restart with zh config -> still Chinese
    {
      const pathA = results.settingsPathA as string;
      const { js, stop } = await launchUi(JSON.parse(fs.readFileSync(pathA, 'utf8')));
      await sleep(1500);
      results.b_restartStillChinese = await js(`document.querySelector('[data-view="devices"]')?.textContent === '设备'`);
      await js(`window.api.setLocale('en').then(() => true)`);
      await sleep(600);
      results.b_switchBackEnglish = await js(`document.querySelector('[data-view="devices"]')?.textContent === 'Devices'`);
      await stop();
    }

    results.ok = Object.entries(results)
      .filter(([k]) => !k.startsWith('settingsPath'))
      .every(([, v]) => v === true);
    console.log('UI_SMOKE_RESULT ' + JSON.stringify(results));
    win.destroy();
    app.exit(results.ok ? 0 : 1);
  } catch (err) {
    console.error('UI_SMOKE_FATAL ' + ((err as Error).stack ?? String(err)));
    app.exit(1);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  if (isUiSmoke) {
    await uiSmokeTest();
    return;
  }
  if (isSmoke) {
    await smokeTest();
    return;
  }
  if (!isPrimaryInstance) {
    return;
  }
  setupCore();
  setupIpc();
  await createWindow();
  _debugFile('window created');
  await core!.start();
  push({ type: 'settings', settings: core!.settings.get() });
  const cfg = core!.settings.get();
  if (cfg.devices.some((d) => d.kind === 'virtual' && d.enabled)) {
    await startSimulator();
    push({ type: 'settings', settings: core!.settings.get() });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  _debugFile('window-all-closed');
  void core?.stop();
  app.quit();
});
