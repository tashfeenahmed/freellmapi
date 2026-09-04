import { describe, it, expect } from 'vitest';
import { trayIsInMenuBar } from '../tray-visibility.js';

// The numbers here are real: both rows were measured on macOS 26.5.2 (build
// 25F84) by creating a tray, reading tray.getBounds(), then hiding the item the
// way Tahoe's Menu Bar settings do (`NSStatusItem VisibleCC Item-0` = 0) and
// reading the bounds again. Nothing about the failure is observable except
// these coordinates, so they are what the guard is asserted against.

const MAIN_DISPLAY = { bounds: { x: 0, y: 0, width: 1728, height: 1117 } };

describe('tray visibility on macOS', () => {
  it('treats an item on the menu-bar row as visible', () => {
    const visible = { x: 1281, y: 0, width: 32, height: 33 };
    expect(trayIsInMenuBar(visible, [MAIN_DISPLAY])).toBe(true);
  });

  it('treats the off-screen park position of a hidden item as not visible', () => {
    const hidden = { x: 0, y: 1117, width: 32, height: 22 };
    expect(trayIsInMenuBar(hidden, [MAIN_DISPLAY])).toBe(false);
  });

  it('counts a menu bar living on a second display', () => {
    // Display above the built-in one: its menu-bar row is at y = -1080, which a
    // hardcoded `y === 0` check would have called hidden.
    const external = { bounds: { x: 0, y: -1080, width: 1920, height: 1080 } };
    const onExternal = { x: 1500, y: -1080, width: 32, height: 33 };
    expect(trayIsInMenuBar(onExternal, [MAIN_DISPLAY, external])).toBe(true);
  });

  it('rejects a zero-sized item, whatever its position', () => {
    expect(trayIsInMenuBar({ x: 0, y: 0, width: 0, height: 0 }, [MAIN_DISPLAY])).toBe(false);
  });
});
