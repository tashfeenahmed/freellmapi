import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tray, Menu, app, nativeImage } from 'electron';
import { togglePopover } from './popover.js';
import { openDashboard } from './window.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;

// Left-click opens the glass popover; right-click keeps a minimal native
// menu as an escape hatch (quit even if the popover renderer breaks).
export function buildTray(port: number, token: string): Tray {
  const iconPath = path.join(__dirname, '../assets/trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true); // auto light/dark tint in the macOS menu bar

  tray = new Tray(icon);
  tray.setToolTip('FreeLLMAPI — local LLM router');

  tray.on('click', () => togglePopover(tray!));
  tray.on('right-click', () => {
    tray!.popUpContextMenu(Menu.buildFromTemplate([
      { label: `Running on 127.0.0.1:${port}`, enabled: false },
      { label: 'Open Dashboard', click: () => openDashboard(port, token) },
      { type: 'separator' },
      { label: 'Quit FreeLLMAPI', click: () => app.quit() },
    ]));
  });

  return tray;
}
