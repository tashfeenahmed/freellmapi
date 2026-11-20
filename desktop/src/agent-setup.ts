import os from 'node:os';
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { getTool } from '../../cli/src/tools.js';
import { applyGeneratedFiles } from '../../cli/src/config-files.js';
import type { CatalogModel } from '../../cli/src/types.js';
import { isTerminalAgent, type AgentSetupBridge, type SetupResult } from '../../shared/agent-setup.js';
import { gatewayBaseUrl } from './base-urls.js';
import { findAgentExecutable, launchAgent } from './agent-terminal.js';

interface SetupHost {
  port(): number;
  key(): string;
  dashboard(): BrowserWindow | null;
  home?: string;
  launch?: typeof launchAgent;
}

export function registerAgentSetup(host: SetupHost): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const homeDir = host.home ?? os.homedir();
  const configured = new Set<string>();
  async function handle(action: keyof AgentSetupBridge, event: IpcMainInvokeEvent, id: unknown): Promise<SetupResult> {
    const url = gatewayBaseUrl(host.port(), 'anthropic');
    const frame = event.senderFrame;
    if (!frame || event.sender !== host.dashboard()?.webContents || frame !== event.sender.mainFrame
        || new URL(frame.url).origin !== url || new URL(frame.url).pathname !== '/agents') {
      throw new Error('Agent setup requires the local dashboard.');
    }
    const tool = typeof id === 'string' && getTool(id);
    if (!tool) throw new Error('Unknown agent.');
    if (action === 'launch') {
      if (!isTerminalAgent(tool.id) || !configured.has(tool.id)) return { ok: false, error: 'config' };
      try {
        const executable = findAgentExecutable(tool.id, homeDir);
        if (!executable) return { ok: false, error: 'missing' };
        await (host.launch ?? launchAgent)(executable, host.key());
        return { ok: true, files: [] };
      } catch { return { ok: false, error: 'terminal' }; }
    }
    if (tool.configType === 'guide') return { ok: true, files: [] };
    const ctx = { url, homeDir, profile: 'default', apiKey: '', models: [] as CatalogModel[] };
    if (action === 'connect') {
      try {
        ctx.apiKey = host.key();
        const response = await fetch(url + '/v1/models?available=true', {
          headers: { Authorization: 'Bearer ' + ctx.apiKey }, redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return { ok: false, error: 'gateway' };
        const { data } = await response.json();
        if (!Array.isArray(data) || !data.length || !data.every(model => typeof model?.id === 'string')) {
          return { ok: false, error: 'catalog' };
        }
        ctx.models = data;
      } catch { return { ok: false, error: 'gateway' }; }
    }
    try {
      const { files } = tool.generate(ctx);
      if (action === 'details') return { ok: true, files: files.map(({ path }) => ({ path })) };
      const written = applyGeneratedFiles(files, false);
      configured.add(tool.id);
      return { ok: true, files: written.map(({ path, changed, backupPath }) => ({ path, changed, backupPath })) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, error: code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'permission' : 'config' };
    }
  }
  for (const action of ['details', 'connect', 'launch'] as const) {
    ipcMain.handle('freeapi:agent-' + action, (event, id: unknown) => handle(action, event, id));
  }
}
