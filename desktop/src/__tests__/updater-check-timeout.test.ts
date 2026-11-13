// #1666: electron-updater has no built-in timeout, so a stalled proxy or an
// unreachable feed left the update check pending forever and the Updates
// dialog spinning on "Checking". The check path (proxy setup + feed request)
// and the download path's proxy step are now bounded; a timeout lands in the
// existing error state with the retry affordance.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { events, autoUpdater } = vi.hoisted(() => {
  const events = new Map<string, (...args: unknown[]) => void>();
  const autoUpdater = {
    netSession: {} as { setProxy?: (cfg: unknown) => Promise<void> },
    on: vi.fn((name: string, fn: (...args: unknown[]) => void) => { events.set(name, fn); return autoUpdater; }),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };
  return { events, autoUpdater };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getName: () => 'FreeLLMAPI', isReady: () => true, on: vi.fn(), whenReady: vi.fn(() => Promise.resolve()) },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  Notification: class { show() {} },
  shell: { openExternal: vi.fn(async () => {}) },
}));

vi.mock('electron-updater', () => ({ default: { autoUpdater } }));

import { checkForUpdates, getUpdateState, initUpdater, _setCheckTimeoutMsForTests } from '../updater.js';

describe('updater check timeout (#1666)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _setCheckTimeoutMsForTests(50);
    // A dev build only gets an updater when a test feed is configured; point
    // it at a dummy feed so updateSupport() reports the build as supported.
    process.env.FREEAPI_UPDATE_FEED = 'http://127.0.0.1:8099/';
    initUpdater({
      autoCheckEnabled: () => false,
      backupBeforeUpdate: () => null,
      getLocale: () => 'en',
      outboundProxyUrl: () => '',
    });
  });
  afterEach(() => {
    delete process.env.FREEAPI_UPDATE_FEED;
    _setCheckTimeoutMsForTests(30_000);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('rejects a stalled feed request into the error state instead of hanging', async () => {
    // Simulate the reported stall: the proxy applies fine, then the feed
    // request never settles.
    autoUpdater.checkForUpdates.mockReturnValue(new Promise(() => {}));
    events.get('checking-for-update')?.();

    const result = checkForUpdates();
    const settled = vi.fn();
    result.then(settled, settled);
    await vi.advanceTimersByTimeAsync(60);

    expect(settled).toHaveBeenCalled();
    const after = getUpdateState();
    expect(after.phase).toBe('error');
    if (after.phase === 'error') {
      expect(after.during).toBe('check');
      expect(after.message).toContain('timed out');
    }
  });

  it('bounds the proxy step too — a proxy that never answers fails the check', async () => {
    autoUpdater.netSession = { setProxy: () => new Promise(() => {}) };
    events.get('checking-for-update')?.();

    const result = checkForUpdates();
    const settled = vi.fn();
    result.then(settled, settled);
    await vi.advanceTimersByTimeAsync(60);

    expect(settled).toHaveBeenCalled();
    const after = getUpdateState();
    expect(after.phase).toBe('error');
    if (after.phase === 'error') expect(after.message).toContain('applying the update proxy');
  });

  it('still succeeds when the check resolves inside the deadline', async () => {
    autoUpdater.netSession = { setProxy: vi.fn(async () => {}) };
    autoUpdater.checkForUpdates.mockResolvedValue({} as never);
    events.get('checking-for-update')?.();

    const pending = checkForUpdates();
    await vi.advanceTimersByTimeAsync(10);
    events.get('update-not-available')?.();
    const state = await pending;
    expect(state.phase).not.toBe('error');
  });
});
