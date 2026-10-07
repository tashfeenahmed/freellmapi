// In-app updates for the packaged desktop app, on top of electron-updater.
//
// The release workflow already publishes what the updater reads: latest.yml,
// latest-mac.yml and latest-linux.yml next to the installers, plus the mac
// .zip (Squirrel.Mac installs from the zip, never the dmg). This module owns the
// whole lifecycle — check, download, install — and hands one serialisable state
// to every surface that shows it: the dashboard (through the preload bridge),
// the tray menu and the native dialogs.
//
// Nothing is downloaded or installed without the user asking, with one
// exception they opt into: when the dashboard's "Check for updates
// automatically" setting is on, a found update is fetched in the background and
// the app says it is ready. It still never restarts on its own — agents are
// routed through this process, and a restart drops their in-flight requests.
import { app, BrowserWindow, dialog, Notification, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { dt, type NativeLocale } from './i18n.js';
import { updateSupport, updaterProxy, type UpdateState } from './update-support.js';

export type { UpdateState };

const { autoUpdater } = electronUpdater;

const RELEASES_URL = 'https://github.com/tashfeenahmed/freellmapi/releases/latest';
const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_BACKGROUND_CHECK_MS = 60 * 1000;

export interface UpdaterHooks {
  /** The dashboard's opt-in (settings table `update_check_enabled`). */
  autoCheckEnabled: () => boolean;
  /** Writes a database backup and returns its file name; runs before every
   *  install. Synchronous so it can also run inside 'before-quit'. */
  backupBeforeUpdate: () => string | null;
  getLocale: () => NativeLocale;
  /** The proxy URL the app's own requests use ('' for none); applied to the
   *  updater's session before every check and download (#1432). */
  outboundProxyUrl: () => string;
  /** Called on every state change, e.g. so the tray can relabel itself. */
  onChange?: (state: UpdateState) => void;
}

let state: UpdateState = { phase: 'idle' };
let hooks: UpdaterHooks | null = null;
let inFlight: Promise<UpdateState> | null = null;
// Set while a check runs in the background, so a found update is downloaded
// straight away instead of waiting for a click nobody is there to make.
let backgroundCheck = false;
// The step under way, so an 'error' event (which electron-updater emits for
// checks and downloads alike) can say which one failed.
let stage: 'check' | 'download' | 'install' = 'check';
// Set once the pre-install backup for the downloaded update has been written,
// so the Restart button and the quit that follows don't write it twice.
let backedUp = false;
// What useAppProxy last handed the session, so an unchanged setting is not
// re-applied (setProxy also drops the session's open connections).
let appliedProxy: string | null = null;
let proxyCredentials = { username: '', password: '' };

export function getUpdateState(): UpdateState {
  return state;
}

function setState(next: UpdateState): void {
  state = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('freeapi:update-state', state);
  }
  hooks?.onChange?.(state);
}

/** Route the updater through the dashboard / env proxy when one is set, and
 *  back to the system settings when it is cleared. */
async function useAppProxy(): Promise<void> {
  const url = hooks?.outboundProxyUrl() ?? '';
  if (url === appliedProxy) return;
  const proxy = updaterProxy(url);
  try {
    await autoUpdater.netSession.setProxy(proxy ? { proxyRules: proxy.rules } : { mode: 'system' });
    proxyCredentials = { username: proxy?.username ?? '', password: proxy?.password ?? '' };
    appliedProxy = url;
  } catch (err) {
    console.warn('[updater] could not apply the proxy to the update session:', err);
  }
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // electron-updater errors can carry a whole HTTP response; the first line is
  // the part a person can act on.
  return text.split('\n')[0].slice(0, 300);
}

export function initUpdater(options: UpdaterHooks): void {
  hooks = options;
  const unsupported = updateSupport({
    isPackaged: app.isPackaged,
    platform: process.platform,
    execPath: process.execPath,
    appImage: process.env.APPIMAGE,
    feed: process.env.FREEAPI_UPDATE_FEED,
    productName: app.getName(),
  });
  if (unsupported) {
    state = unsupported;
    return;
  }

  if (process.env.FREEAPI_UPDATE_FEED) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.FREEAPI_UPDATE_FEED });
  }
  autoUpdater.logger = console;
  autoUpdater.autoDownload = false;
  // A downloaded update installs on the next ordinary quit as well, so an
  // update the user never got round to restarting for still lands.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking' }));
  autoUpdater.on('update-not-available', () => setState({ phase: 'current', checkedAt: new Date().toISOString() }));
  autoUpdater.on('update-available', (info) => {
    setState({ phase: 'available', version: info.version });
    if (backgroundCheck) void downloadUpdate();
  });
  autoUpdater.on('download-progress', (progress) => {
    if (state.phase !== 'available' && state.phase !== 'downloading') return;
    setState({ phase: 'downloading', version: state.version, percent: Math.floor(progress.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setState({ phase: 'ready', version: info.version });
    if (Notification.isSupported()) {
      const locale = options.getLocale();
      new Notification({
        title: dt(locale, 'updateReadyTitle', { version: info.version }),
        body: dt(locale, 'updateReadyBody'),
      }).show();
    }
  });
  // Chromium asks for proxy credentials here rather than reading them from
  // the proxy rules.
  autoUpdater.on('login', (authInfo, callback) => {
    if (authInfo.isProxy && proxyCredentials.username) callback(proxyCredentials.username, proxyCredentials.password);
    // No arguments cancels the challenge, which Chromium reports as a 407.
    else (callback as () => void)();
  });
  autoUpdater.on('error', (err) => setState({ phase: 'error', during: stage, message: message(err) }));

  // A downloaded update also installs on an ordinary quit (autoInstallOnAppQuit);
  // that path must get the same backup the Restart button takes.
  app.on('before-quit', () => {
    if (state.phase !== 'ready' || backedUp) return;
    try {
      backup();
    } catch (err) {
      console.warn('[updater] backup before the quit-time install failed:', err);
    }
  });

  setTimeout(runBackgroundCheck, FIRST_BACKGROUND_CHECK_MS).unref();
  setInterval(runBackgroundCheck, BACKGROUND_INTERVAL_MS).unref();
}

function runBackgroundCheck(): void {
  if (!hooks?.autoCheckEnabled()) return;
  if (state.phase === 'downloading' || state.phase === 'ready') return;
  backgroundCheck = true;
  void checkForUpdates().finally(() => { backgroundCheck = false; });
}

export function checkForUpdates(): Promise<UpdateState> {
  if (state.phase === 'unsupported' || state.phase === 'downloading' || state.phase === 'ready') {
    return Promise.resolve(state);
  }
  if (!inFlight) stage = 'check';
  inFlight ??= useAppProxy()
    .then(() => autoUpdater.checkForUpdates())
    .then(() => state)
    .catch((err) => {
      setState({ phase: 'error', during: 'check', message: message(err) });
      return state;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.phase !== 'available') return state;
  stage = 'download';
  setState({ phase: 'downloading', version: state.version, percent: 0 });
  try {
    await useAppProxy();
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setState({ phase: 'error', during: 'download', message: message(err) });
  }
  return state;
}

function backup(): void {
  if (state.phase !== 'ready') return;
  const file = hooks?.backupBeforeUpdate();
  backedUp = true;
  if (file) console.log(`[updater] backed up the database to ${file} before installing v${state.version}`);
}

/** Back the database up, then quit, install and relaunch. */
export async function installUpdate(): Promise<UpdateState> {
  if (state.phase !== 'ready') return state;
  stage = 'install';
  try {
    backup();
  } catch (err) {
    // A failed backup must not install over data it could not save.
    setState({ phase: 'error', during: 'install', message: `Backup before update failed: ${message(err)}` });
    return state;
  }
  // Let the IPC reply reach the renderer before the process starts to quit.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return state;
}

/** Tray → "Check for Updates…": the same lifecycle with native dialogs. */
export async function checkFromTray(): Promise<void> {
  const locale = hooks?.getLocale() ?? 'en';
  if (state.phase === 'unsupported') {
    await shell.openExternal(RELEASES_URL);
    return;
  }
  if (state.phase === 'ready') {
    await offerRestart(locale, state.version);
    return;
  }
  const result = await checkForUpdates();
  if (result.phase === 'current') {
    await dialog.showMessageBox({ type: 'info', message: dt(locale, 'upToDate', { version: app.getVersion() }) });
  } else if (result.phase === 'available') {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: dt(locale, 'updateAvailable', { version: result.version }),
      detail: dt(locale, 'updateAvailableDetail', { current: app.getVersion() }),
      buttons: [dt(locale, 'downloadUpdate'), dt(locale, 'releaseNotes'), dt(locale, 'later')],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) {
      const downloaded = await downloadUpdate();
      if (downloaded.phase === 'ready') await offerRestart(locale, downloaded.version);
    } else if (response === 1) {
      await shell.openExternal(RELEASES_URL);
    }
  } else if (result.phase === 'error') {
    dialog.showErrorBox(dt(locale, 'updateFailed'), result.message);
  }
}

async function offerRestart(locale: NativeLocale, version: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: dt(locale, 'updateReadyTitle', { version }),
    detail: dt(locale, 'updateReadyBody'),
    buttons: [dt(locale, 'restartToUpdate'), dt(locale, 'later')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await installUpdate();
}
