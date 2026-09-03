/**
 * Preload — context-isolated IPC bridge for the renderer (round-15 API).
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

const api = {
  // core state
  getSettings: () => ipcRenderer.invoke('core:get-settings'),
  updateSettings: (patch: unknown) => ipcRenderer.invoke('core:update-settings', patch),
  setLocale: (locale: string) => ipcRenderer.invoke('core:set-locale', locale),
  // devices
  listDevices: () => ipcRenderer.invoke('core:list-devices'),
  refreshDevices: () => ipcRenderer.invoke('core:refresh-devices'),
  connectDevice: (id: string, profileId?: string) => ipcRenderer.invoke('core:connect-device', id, profileId),
  disconnectDevice: (id: string) => ipcRenderer.invoke('core:disconnect-device', id),
  assignProfile: (interfacePath: string, profileId: string) => ipcRenderer.invoke('core:assign-profile', interfacePath, profileId),
  listProfiles: () => ipcRenderer.invoke('core:list-profiles'),
  setDeviceWriteEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('core:device-write-enabled', id, enabled),
  setWritePolicy: (policy: string) => ipcRenderer.invoke('core:write-policy', policy),
  getWritePolicy: () => ipcRenderer.invoke('core:get-write-policy'),
  setWritesDisabled: (v: boolean) => ipcRenderer.invoke('core:writes-disabled', v),
  getWritesDisabled: () => ipcRenderer.invoke('core:get-writes-disabled'),
  setShowAllInterfaces: (v: boolean) => ipcRenderer.invoke('core:set-show-all', v),
  // audit
  recentAudit: () => ipcRenderer.invoke('core:audit'),
  writeCount: () => ipcRenderer.invoke('core:write-count'),
  // ask-policy confirmation
  confirmOp: (token: string, op?: unknown) => ipcRenderer.invoke('core:confirm-op', token, op),
  pendingConfirmations: () => ipcRenderer.invoke('core:pending-confirmations'),
  triggerOp: (op: unknown) => ipcRenderer.invoke('core:trigger-op', op),
  // actions
  triggerAction: (action: string) => ipcRenderer.invoke('core:trigger-action', action),
  // simulator
  startSimulator: (mode?: string) => ipcRenderer.invoke('sim:start', mode),
  stopSimulator: () => ipcRenderer.invoke('sim:stop'),
  simStatus: () => ipcRenderer.invoke('sim:status'),
  configPath: () => ipcRenderer.invoke('app:config-path'),
  // local Agent API
  startLocalApi: (cfg?: unknown) => ipcRenderer.invoke('api:start', cfg),
  stopLocalApi: () => ipcRenderer.invoke('api:stop'),
  apiStatus: () => ipcRenderer.invoke('api:status'),
  apiToken: () => ipcRenderer.invoke('api:token'),
  apiRevokeToken: () => ipcRenderer.invoke('api:revoke-token'),
  apiSetConflictPolicy: (p: string, pinned?: string) => ipcRenderer.invoke('api:conflict-policy', p, pinned),
  apiTestEvent: () => ipcRenderer.invoke('api:test'),
  importDefinition: (raw: string) => ipcRenderer.invoke('core:import-definition', raw),
  bindDefinition: (ifacePath: string, profileId: string) => ipcRenderer.invoke('core:bind-definition', ifacePath, profileId),
  unbindProfile: (ifacePath: string) => ipcRenderer.invoke('core:unbind-profile', ifacePath),
  exportDiagnostics: () => ipcRenderer.invoke('core:export-diagnostics'),
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on('core-event', listener);
    return () => ipcRenderer.removeListener('core-event', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
