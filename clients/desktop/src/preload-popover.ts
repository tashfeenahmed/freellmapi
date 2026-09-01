// Built to build/preload-popover.cjs. Exposes the minimal IPC surface the
// popover UI needs — no Node access in the renderer.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('freeapi', {
  snapshot: () => ipcRenderer.invoke('freeapi:snapshot'),
  openDashboard: () => ipcRenderer.invoke('freeapi:open-dashboard'),
  copyBaseUrl: () => ipcRenderer.invoke('freeapi:copy-base-url'),
  copyApiKey: () => ipcRenderer.invoke('freeapi:copy-api-key'),
  setLoginItem: (open: boolean) => ipcRenderer.invoke('freeapi:set-login-item', open),
  quit: () => ipcRenderer.invoke('freeapi:quit'),
  onRefresh: (cb: () => void) => ipcRenderer.on('freeapi:refresh', cb),
});
