import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, ipcMain, clipboard, nativeTheme, shell } from 'electron';
import { startServer, ensureSessionToken, getUnifiedApiKey } from './server.mjs';
import { loadConfig, saveConfig } from './config.js';
import { buildTray, refreshTrayLocale } from './tray.js';
import { openDashboard } from './window.js';
import { todayStats, hourlyRequests, successRateToday } from './stats.js';
import { normalizeLocale, nativeStrings, type NativeLocale } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 31415;

// Lean posture: one instance, menu-bar only. GPU stays ON — vibrancy
// (the popover/dashboard glass) needs GPU compositing; with hardware
// acceleration disabled, transparent windows render an opaque white.
app.setName('FreeLLMAPI');
app.setPath('userData', path.join(app.getPath('appData'), 'FreeLLMAPI'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let resolvedPort = DEFAULT_PORT;
  let sessionToken = '';
  // The dashboard owns the theme (its navbar toggle); the popover and the
  // window vibrancy follow. Last choice persists in config; before the
  // dashboard has ever reported, fall back to the system appearance —
  // matching the dashboard's own prefers-color-scheme default.
  let theme: 'dark' | 'light' =
    (process.env.FREEAPI_THEME as 'dark' | 'light' | undefined) // dev-only screenshot override
    ?? loadConfig().theme
    ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  nativeTheme.themeSource = theme;
  // The dashboard also owns the language (its ⋯-menu selector); the native tray
  // menu and popover follow via the same mirror-and-persist pattern as the theme.
  let locale: NativeLocale = normalizeLocale(
    (process.env.FREEAPI_LOCALE as string | undefined) ?? loadConfig().locale,
  );

  app.on('second-instance', () => {
    if (sessionToken) openDashboard(resolvedPort, sessionToken);
  });

  // The app lives in the tray; closing the dashboard window must not quit.
  app.on('window-all-closed', () => {});

  // Every window is a view onto the local dashboard, so anything that isn't
  // the local server belongs in the system browser. Without a window-open
  // handler, target="_blank" links (e.g. "Get API key" on the Keys page)
  // spawn a bare child window that inherits our preload and renders blank
  // (#304) — deny the window and hand the URL to the OS instead. Only
  // http(s) ever reaches openExternal.
  const isExternal = (url: string) => {
    try {
      const u = new URL(url);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '127.0.0.1';
    } catch {
      return false;
    }
  };
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternal(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isExternal(url)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
  });

  // ── popover IPC ──────────────────────────────────────────────────────────
  ipcMain.handle('freeapi:snapshot', () => {
    const s = todayStats();
    return {
      port: resolvedPort,
      requests: s.requests,
      tokens: s.tokens,
      lastModel: s.lastModel,
      successRate: successRateToday(),
      hourly: hourlyRequests(),
      loginItem: app.getLoginItemSettings().openAtLogin,
      theme,
      locale,
      // The popover renderer is a file:// page with no access to the desktop
      // i18n module, so ship it the resolved string bundle for the active locale.
      strings: nativeStrings(locale),
    };
  });
  ipcMain.on('freeapi:theme-changed', async (_e, next: 'dark' | 'light') => {
    if (next !== 'dark' && next !== 'light') return;
    if (next === theme) return;
    theme = next;
    saveConfig({ ...loadConfig(), theme });
    // Flips the vibrancy materials (popover glass + dashboard backdrop).
    nativeTheme.themeSource = theme;
    const { getPopoverWindow } = await import('./popover.js');
    getPopoverWindow()?.webContents.send('freeapi:refresh');
  });
  ipcMain.on('freeapi:locale-changed', async (_e, raw: string) => {
    const next = normalizeLocale(raw);
    if (next === locale) return;
    locale = next;
    saveConfig({ ...loadConfig(), locale });
    refreshTrayLocale(locale);
    // Re-label the popover if it's open (snapshot now carries the new strings).
    const { getPopoverWindow } = await import('./popover.js');
    getPopoverWindow()?.webContents.send('freeapi:refresh');
  });
  ipcMain.handle('freeapi:open-dashboard', () => openDashboard(resolvedPort, sessionToken));
  ipcMain.handle('freeapi:copy-base-url', () => clipboard.writeText(`http://127.0.0.1:${resolvedPort}/v1`));
  ipcMain.handle('freeapi:copy-api-key', () => clipboard.writeText(getUnifiedApiKey()));
  ipcMain.handle('freeapi:set-login-item', (_e, open: boolean) => app.setLoginItemSettings({ openAtLogin: open }));
  ipcMain.handle('freeapi:quit', () => app.quit());

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock?.hide();

    const cfg = loadConfig();
    const dbPath = path.join(app.getPath('userData'), 'freeapi.db');
    // Packaged: client/dist ships in extraResources (Resources/client-dist).
    // Dev: use this repo's own client/dist (desktop/ lives in the monorepo;
    // FREEAPI_REPO can still point at a different checkout if ever needed).
    const repoRoot = process.env.FREEAPI_REPO ?? path.resolve(__dirname, '../..');
    const clientDist = app.isPackaged
      ? path.join(process.resourcesPath, 'client-dist')
      : path.join(repoRoot, 'client/dist');

    try {
      const { port } = await startServer({
        dbPath,
        clientDist,
        host: '127.0.0.1',
        preferredPort: cfg.port ?? DEFAULT_PORT,
      });
      resolvedPort = port;
      saveConfig({ ...cfg, port });
      sessionToken = ensureSessionToken();
      const tray = buildTray(port, sessionToken, () => locale);
      console.log(`[desktop] FreeLLMAPI running on http://127.0.0.1:${port}`);

      // Dev-only UI verification: FREEAPI_SHOT=1 opens the popover and the
      // dashboard, captures both to /tmp, and quits. FREEAPI_SHOT=hold opens
      // the popover and keeps it pinned (blur ignored) so a real screen
      // capture can include the compositor's vibrancy. Never set when packaged.
      if (process.env.FREEAPI_SHOT && !app.isPackaged) {
        const fs = await import('node:fs');
        const { togglePopover, getPopoverWindow } = await import('./popover.js');
        const { getDashboardWindow } = await import('./window.js');
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await sleep(800);
        togglePopover(tray);
        if (process.env.FREEAPI_SHOT === 'hold') {
          const pop = getPopoverWindow();
          pop?.removeAllListeners('blur'); // stay open unfocused
          if (pop) fs.writeFileSync('/tmp/freeapi-popover-bounds.json', JSON.stringify(pop.getBounds()));
          // FREEAPI_THEME forces a theme for captures — skip the dashboard
          // then, or its theme report would immediately override the override.
          if (!process.env.FREEAPI_THEME) {
            openDashboard(port, sessionToken);
            await sleep(2500);
            const dashWin = getDashboardWindow();
            if (dashWin) {
              dashWin.show();
              dashWin.focus();
              dashWin.moveTop();
              fs.writeFileSync('/tmp/freeapi-dashboard-bounds.json', JSON.stringify(dashWin.getBounds()));
            }
          }
          return;
        }
        await sleep(1500);
        const pop = await getPopoverWindow()?.webContents.capturePage();
        if (pop) fs.writeFileSync('/tmp/freeapi-popover.png', pop.toPNG());
        openDashboard(port, sessionToken);
        await sleep(3000);
        const dash = await getDashboardWindow()?.webContents.capturePage();
        if (dash) fs.writeFileSync('/tmp/freeapi-dashboard.png', dash.toPNG());
        app.quit();
      }
    } catch (err: any) {
      dialog.showErrorBox(
        'FreeLLMAPI failed to start',
        err?.message ?? String(err),
      );
      app.quit();
    }
  });
}
