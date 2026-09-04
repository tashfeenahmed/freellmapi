// macOS 26 (Tahoe) gave every user a per-app switch for menu-bar icons in
// System Settings > Menu Bar. Switching ours off persists
// `"NSStatusItem VisibleCC Item-0" = 0` in the app's own defaults domain, and
// from then on `new Tray()` still succeeds — no throw, no log, no crash report
// — while nothing is drawn. Since the tray is the only entry point into the UI,
// the app is then alive and serving the API with no way to reach it (#807).
//
// What does change is where macOS parks the item. Measured on macOS 26.5.2
// (build 25F84): a real menu-bar item reports {x: 1281, y: 0}, a hidden one
// {x: 0, y: 1117} — y is the screen height, i.e. off the bottom of the display.
// The check is written against display bounds rather than a hardcoded y === 0
// so that a menu bar living on a second display still counts as visible.

export interface TrayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  bounds: TrayRect;
}

// A couple of pixels of slack: the item's frame starts at the very top edge of
// whichever display owns the menu bar.
const TOP_EDGE_SLACK_PX = 2;

export function trayIsInMenuBar(
  bounds: TrayRect,
  displays: readonly DisplayLike[],
): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  return displays.some((d) => Math.abs(bounds.y - d.bounds.y) <= TOP_EDGE_SLACK_PX);
}
