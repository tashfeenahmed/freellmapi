import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tray, Menu, app, nativeImage } from 'electron';
import { togglePopover } from './popover.js';
import { openDashboard } from './window.js';
import { openLogsFolder, openBackupsFolder } from './logger.js';
import { dt, type NativeLocale } from './i18n.js';
import { trayPlatform } from './tray-platform.js';
import type { UpdateState } from './update-support.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

// Left-click opens the glass popover (the dashboard itself on Windows, see
// tray-platform.ts); right-click keeps a minimal native menu as an escape
// hatch (quit even if the popover renderer breaks). The menu is rebuilt on
// every right-click, so reading the live locale via getLocale() keeps its
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
  tray.on('right-click', () => {
    const locale = getLocale();
    const lanOn = getLanAccess();
    tray!.popUpContextMenu(Menu.buildFromTemplate([
      { label: dt(locale, 'runningOn', { addr: `${lanOn ? '0.0.0.0' : '127.0.0.1'}:${port}` }), enabled: false },
      { label: dt(locale, 'openDashboard'), click: () => openDashboard(port, token) },
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
    ]));
  });

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
}
