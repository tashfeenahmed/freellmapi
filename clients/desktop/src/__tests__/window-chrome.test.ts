import { describe, it, expect } from 'vitest';
import { platformChrome } from '../window-chrome.js';

// #703 reported a stock Electron menu bar permanently above the dashboard on
// Windows. The fix lives in a branch that never runs on the mac this repo is
// developed on, so it is asserted here rather than trusted.

describe('dashboard window chrome per platform', () => {
  it('hides the stock menu bar on Windows', () => {
    expect(platformChrome('win32').autoHideMenuBar).toBe(true);
  });

  it('hides it on Linux too — same stock menu, same complaint', () => {
    expect(platformChrome('linux').autoHideMenuBar).toBe(true);
  });

  it('leaves macOS alone: no menu-bar flag, and the vibrancy chrome is intact', () => {
    const mac = platformChrome('darwin');
    // macOS has no in-window menu bar to hide, and setting the flag there would
    // be meaningless at best; the app menu lives in the system bar.
    expect(mac.autoHideMenuBar).toBeUndefined();
    expect(mac.titleBarStyle).toBe('hiddenInset');
    expect(mac.vibrancy).toBe('sidebar');
    expect(mac.backgroundColor).toBe('#00000000');
  });

  it('gives every platform an opaque background except macOS, which is glass', () => {
    expect(platformChrome('win32').backgroundColor).toBe('#09090b');
    expect(platformChrome('linux').backgroundColor).toBe('#09090b');
  });
});
