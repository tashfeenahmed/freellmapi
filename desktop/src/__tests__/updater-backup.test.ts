import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The pre-install database backup guarantee (updater.ts). A downloaded update
// installs either from the Restart button or on an ordinary quit
// (autoInstallOnAppQuit); both must back up first, and an install whose backup
// failed must not go ahead on the next quit either.

const { appEvents, autoUpdater } = await vi.hoisted(async () => {
  // vi.mock factories are hoisted above the imports, so build the fakes here.
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    appEvents: new Emitter(),
    autoUpdater: Object.assign(new Emitter(), {
      autoInstallOnAppQuit: false,
      autoDownload: true,
      forceDevUpdateConfig: false,
      logger: null as unknown,
      netSession: { setProxy: async () => {} },
      checkForUpdates: async () => {},
      downloadUpdate: async () => {},
      quitAndInstall: (() => {}) as (...args: unknown[]) => void,
      setFeedURL: () => {},
    }),
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'FreeLLMAPI',
    getVersion: () => '1.0.0',
    on: (event: string, handler: (...args: unknown[]) => void) => appEvents.on(event, handler),
  },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  dialog: {},
  shell: {},
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

let backupBeforeUpdate: ReturnType<typeof vi.fn<() => string | null>>;
let quitAndInstall: ReturnType<typeof vi.fn>;

async function load() {
  vi.resetModules();
  appEvents.removeAllListeners();
  autoUpdater.removeAllListeners();
  quitAndInstall = vi.fn();
  autoUpdater.quitAndInstall = quitAndInstall;
  backupBeforeUpdate = vi.fn<() => string | null>(() => 'backup.db');
  const updater = await import('../updater.js');
  updater.initUpdater({
    autoCheckEnabled: () => false,
    backupBeforeUpdate,
    getLocale: () => 'en',
    outboundProxyUrl: () => '',
  });
  return updater;
}

const downloaded = (version: string) => autoUpdater.emit('update-downloaded', { version });
const quit = () => appEvents.emit('before-quit');
const failBackups = () => backupBeforeUpdate.mockImplementation(() => { throw new Error('disk full'); });

describe('updater pre-install backup', () => {
  beforeEach(() => {
    // An unpackaged build only runs the real lifecycle against a test feed.
    process.env.FREEAPI_UPDATE_FEED = 'http://127.0.0.1:8099/';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.FREEAPI_UPDATE_FEED;
    vi.restoreAllMocks();
  });

  it('backs up before the quit-time install', async () => {
    await load();
    downloaded('2.0.0');
    quit();
    expect(backupBeforeUpdate).toHaveBeenCalledTimes(1);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('does not install on quit when the quit-time backup fails', async () => {
    await load();
    downloaded('2.0.0');
    failBackups();
    quit();
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('keeps a Restart whose backup failed from installing on the next quit', async () => {
    const updater = await load();
    downloaded('2.0.0');
    failBackups();
    expect(await updater.installUpdate()).toMatchObject({ phase: 'error', during: 'install' });
    await new Promise(resolve => setImmediate(resolve));
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    quit();
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('still backs up on quit when an error followed the download', async () => {
    await load();
    downloaded('2.0.0');
    autoUpdater.emit('error', new Error('feed unreachable'));
    quit();
    expect(backupBeforeUpdate).toHaveBeenCalledTimes(1);
  });

  it('backs up again for a later download', async () => {
    const updater = await load();
    downloaded('2.0.0');
    await updater.installUpdate();
    expect(backupBeforeUpdate).toHaveBeenCalledTimes(1);
    downloaded('3.0.0');
    quit();
    expect(backupBeforeUpdate).toHaveBeenCalledTimes(2);
  });

  it('re-arms the quit-time install when the update is downloaded again', async () => {
    await load();
    downloaded('2.0.0');
    failBackups();
    quit();
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
    downloaded('2.0.0');
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });
});
