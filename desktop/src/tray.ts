import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tray, Menu, app, nativeImage } from 'electron';
import { togglePopover } from './popover.js';
import { openDashboard } from './window.js';
import { openLogsFolder, openBackupsFolder } from './logger.js';
import { dt, type NativeLocale } from './i18n.js';
import { trayMenuOffersPopover, trayPlatform } from './tray-platform.js';
import type { UpdateState } from './update-support.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
// Rebuilds the attached menu where the platform uses one (Linux, #1804).
let refreshAttachedMenu: (() => void) | null = null;

// Left-click opens the glass popover (the dashboard itself on Windows, see
// tray-platform.ts); right-click keeps a minimal native menu as an escape
// hatch (quit even if the popover renderer breaks). On Linux the menu is
// attached to the icon instead (#1804). The menu is rebuilt on every
// right-click (and on every change where it is attached), so reading the live locale via getLocale() keeps its
// labels current after a language switch; the static tooltip is refreshed
// separately (refreshTrayLocale).
export function buildTray(
  port: number,
  token: string,
  getLocale: () => NativeLocale,
  getLanAccess: () => boolean,
  onToggleLanAccess: () => void,
  getShowInDock: () => boolean,
  onToggleShowInDock: () => void,
  getUpdateState: () => UpdateState,
  onUpdateClick: () => void,
): Tray {
  const platform = trayPlatform(process.platform);
  const iconPath = path.join(__dirname, '../assets', platform.iconFile);
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) console.warn(`[desktop] tray icon did not load from ${iconPath}`);
  // Auto light/dark tint in the macOS menu bar. Elsewhere it is meaningless,
  // and Windows rejected the image it produced (#1353).
  if (platform.templateImage) icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip(dt(getLocale(), 'tooltip'));

  if (platform.leftClick === 'dashboard') {
    tray.on('click', () => openDashboard(port, token));
  } else {
    tray.on('click', () => togglePopover(tray!));
  }
  const buildMenu = (): Menu => {
    const locale = getLocale();
    const lanOn = getLanAccess();
    return Menu.buildFromTemplate([
      { label: dt(locale, 'runningOn', { addr: `${lanOn ? '0.0.0.0' : '127.0.0.1'}:${port}` }), enabled: false },
      { label: dt(locale, 'openDashboard'), click: () => openDashboard(port, token) },
      // #1412: on Windows left-click deliberately opens the dashboard instead of
      // the popover (#1353), which used to leave the compact panel with no entry
      // point at all. Only offer it where the click does not already toggle it.
      ...(trayMenuOffersPopover(process.platform)
        ? [{ label: dt(locale, 'showCompactPanel'), click: () => togglePopover(tray!) }]
        : []),
      { type: 'separator' },
      // Toggling relaunches the app (the bind host is fixed at server start).
      { label: dt(locale, 'lanAccess'), type: 'checkbox', checked: lanOn, click: () => onToggleLanAccess() },
      // The Dock icon is the "yes, it is running" signal the tray cannot always
      // give: macOS 26 lets the user hide menu-bar icons, and a notched display
      // clips them (#807). Applied live, no relaunch.
      { label: dt(locale, 'showInDock'), type: 'checkbox', checked: getShowInDock(), click: () => onToggleShowInDock() },
      // #824: the password-reset code is printed to the log and nowhere else,
      // so the folder holding it needs to be reachable without a terminal.
      { label: dt(locale, 'openLogs'), click: () => openLogsFolder() },
      // Scheduled/manual backups land in <userData>/backups; the dashboard
      // only shows relative paths, so the tray is the discovery point.
      { label: dt(locale, 'openBackups'), click: () => openBackupsFolder() },
      { type: 'separator' },
      { label: updateLabel(locale, getUpdateState()), click: () => onUpdateClick() },
      { label: dt(locale, 'quitApp'), click: () => app.quit() },
    ]);
  };

  if (platform.menu === 'attached') {
    refreshAttachedMenu = () => tray?.setContextMenu(buildMenu());
    refreshAttachedMenu();
  } else {
    tray.on('right-click', () => tray!.popUpContextMenu(buildMenu()));
  }

  return tray;
}

function updateLabel(locale: NativeLocale, state: UpdateState): string {
  return state.phase === 'ready'
    ? dt(locale, 'restartToUpdateTray', { version: state.version })
    : dt(locale, 'checkForUpdates');
}

// Update the static tooltip after a locale change (the menu reads the locale
// live when it opens, so it needs no explicit refresh).
export function refreshTrayLocale(locale: NativeLocale): void {
  tray?.setToolTip(dt(locale, 'tooltip'));
  refreshAttachedMenu?.();
}

// A popped-up menu is built fresh on each right-click; an attached one (Linux)
// has to be rebuilt when something it shows changes (update state, toggles).
export function refreshTrayMenu(): void {
  refreshAttachedMenu?.();
}
