// Per-platform tray behaviour, kept free of Electron imports so it can be
// asserted on the mac this repo is developed on (#1353).
//
// The tray was written for the macOS menu bar: a black template PNG that the
// system tints, and a left-click glass popover. On Windows that combination
// failed outright. Shell_NotifyIcon wants an .ico, a template image is a
// macOS-only concept, and the result was "Unable to create status tray icon"
// with an app that looked like it had crashed.

export interface TrayPlatform {
  // File under desktop/assets/ to build the tray icon from.
  iconFile: string;
  // nativeImage.setTemplateImage(true): only the macOS menu bar honours it.
  templateImage: boolean;
  // What a plain left-click does. The popover is a macOS menu-bar idiom (and
  // its vibrancy material is macOS-only); a Windows tray click is expected to
  // bring up the app itself.
  leftClick: 'popover' | 'dashboard';
  // How the native menu opens. 'popup': we listen for right-click and call
  // popUpContextMenu. Electron emits right-click and supports popUpContextMenu
  // on macOS and Windows only, so on Linux that left no menu and no way to
  // quit (#1804). 'attached': the menu is set on the icon with setContextMenu
  // and the desktop shell opens it.
  menu: 'popup' | 'attached';
}

export function trayPlatform(platform: NodeJS.Platform): TrayPlatform {
  if (platform === 'darwin') {
    return { iconFile: 'trayTemplate.png', templateImage: true, leftClick: 'popover', menu: 'popup' };
  }
  if (platform === 'win32') {
    // Multi-size .ico (16 to 64 px) so every DPI scale gets a crisp frame.
    return { iconFile: 'tray.ico', templateImage: false, leftClick: 'dashboard', menu: 'popup' };
  }
  // Linux panels do not tint either, and most are dark, where the black
  // template glyph disappears; use the full-colour icon instead.
  return { iconFile: 'tray.png', templateImage: false, leftClick: 'popover', menu: 'attached' };
}

// #1412: the compact popover has no keyboard shortcut and no window of its own,
// so the tray is its only entry point. Where left-click is already claimed by
// the dashboard (Windows, deliberately, since #1353) the tray menu has to offer
// it or the popover is unreachable. Elsewhere left-click toggles it already and
// the item would just be a second way to do the same thing.
// On Linux many panels open the attached menu on left-click too, so the click
// cannot be counted on to reach the popover there either (#1804).
export function trayMenuOffersPopover(platform: NodeJS.Platform): boolean {
  const tray = trayPlatform(platform);
  return tray.leftClick !== 'popover' || tray.menu === 'attached';
}

// Windows tucks new tray icons into the overflow flyout, so a first launch can
// look like nothing happened at all (#1353). Open the dashboard once there so
// the user sees the app is up; after that the tray is the way in. A tray that
// failed to build leaves no other visible entry point, so that case opens it
// on every platform and every launch.
export function shouldOpenDashboardOnLaunch(
  platform: NodeJS.Platform,
  opts: { trayBuilt: boolean; welcomedBefore: boolean },
): boolean {
  if (!opts.trayBuilt) return true;
  return platform === 'win32' && !opts.welcomedBefore;
}
