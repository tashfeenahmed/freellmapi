// The per-platform half of the dashboard window's options, kept in its own
// module with NO electron import so it can be tested off-platform.
//
// Windows is the case that needed proving: #703 reported a stock Electron
// File/Edit/View menu bar sitting permanently above the dashboard, and the fix
// is one flag in a branch that never executes on the machine this repo is
// usually developed on. A pure function makes "Windows and Linux get
// autoHideMenuBar, macOS keeps its vibrancy chrome" checkable in CI on any host,
// which is as close to verification as we get without a Windows machine.

export interface PlatformChrome {
  backgroundColor: string;
  titleBarStyle?: 'hiddenInset';
  vibrancy?: 'sidebar';
  visualEffectState?: 'followWindow';
  /** Hides Electron's default menu bar; Alt still reveals it (Win/Linux only). */
  autoHideMenuBar?: boolean;
}

/**
 * @param platform `process.platform` of the host the window is opening on.
 */
export function platformChrome(platform: NodeJS.Platform | string): PlatformChrome {
  if (platform === 'darwin') {
    // Traffic lights float over the app's own header (the client adds a drag
    // region + left padding when it detects the desktop shell), and the window
    // carries a sidebar vibrancy — the strong, Finder-style material — so the
    // client's translucent desktop backdrop (html.desktop in index.css) shows
    // real glass, matching the tray popover. The material follows
    // nativeTheme.themeSource, i.e. the dashboard's own theme.
    return {
      titleBarStyle: 'hiddenInset',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
    };
  }
  return {
    backgroundColor: '#09090b',
    // Windows and Linux otherwise carry Electron's stock File/Edit/View menu
    // permanently — none of it does anything this app needs, and it cannot be
    // dismissed (#703). Hidden rather than removed so the menu's clipboard
    // accelerators keep working; Alt still reveals it.
    autoHideMenuBar: true,
  };
}
