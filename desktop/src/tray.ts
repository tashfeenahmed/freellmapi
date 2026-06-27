import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tray, Menu, app, nativeImage } from 'electron';
import { togglePopover } from './popover.js';
import { openDashboard } from './window.js';
import { dt, type NativeLocale } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

// Left-click opens the glass popover; right-click keeps a minimal native
// menu as an escape hatch (quit even if the popover renderer breaks). The menu
// is rebuilt on every right-click, so reading the live locale via getLocale()
// keeps its labels current after a language switch; the static tooltip is
// refreshed separately (refreshTrayLocale).
export function buildTray(port: number, token: string, getLocale: () => NativeLocale): Tray {
  const iconPath = path.join(__dirname, '../assets/trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true); // auto light/dark tint in the macOS menu bar

  tray = new Tray(icon);
  tray.setToolTip(dt(getLocale(), 'tooltip'));

  tray.on('click', () => togglePopover(tray!));
  tray.on('right-click', () => {
    const locale = getLocale();
    tray!.popUpContextMenu(Menu.buildFromTemplate([
      { label: dt(locale, 'runningOn', { addr: `127.0.0.1:${port}` }), enabled: false },
      { label: dt(locale, 'openDashboard'), click: () => openDashboard(port, token) },
      { type: 'separator' },
      { label: dt(locale, 'quitApp'), click: () => app.quit() },
    ]));
  });

  return tray;
}

// Update the static tooltip after a locale change (the menu reads the locale
// live when it opens, so it needs no explicit refresh).
export function refreshTrayLocale(locale: NativeLocale): void {
  tray?.setToolTip(dt(locale, 'tooltip'));
}
