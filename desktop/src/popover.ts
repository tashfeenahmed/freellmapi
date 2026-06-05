import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, type Tray } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WIDTH = 316;
const HEIGHT = 348;

let popover: BrowserWindow | null = null;

// A Control-Center-style glass panel anchored under the tray icon.
// Real macOS material: frameless window with SYSTEM rounded corners +
// NSVisualEffectView vibrancy + native shadow. No `transparent: true` —
// that path composites the window itself and defeats the vibrancy blur;
// instead the page background stays transparent and the material shows
// through. Created once, then shown/hidden; hides on blur like a menu.
function createPopover(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    roundedCorners: true, // native macOS corner mask + matching shadow
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...(process.platform === 'darwin'
      ? {
          // 'popover' follows the app appearance, which main.ts pins via
          // nativeTheme.themeSource to the DASHBOARD's theme choice — so the
          // glass flips dark/light together with the dashboard. The dark
          // variant is deepened toward black by the panel's CSS tint.
          vibrancy: 'popover' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : {
          // Windows 11 acrylic; older Windows falls back to the solid CSS bg.
          backgroundMaterial: 'acrylic' as const,
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload-popover.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  // Show over fullscreen apps, like every menu bar utility.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile(path.join(__dirname, '../renderer/popover.html')).then(() => {
    if (process.platform !== 'darwin') {
      win.webContents.executeJavaScript("document.body.classList.add('no-vibrancy')");
    }
  });

  win.on('blur', () => win.hide());
  win.on('closed', () => {
    popover = null;
  });
  return win;
}

export function getPopoverWindow(): BrowserWindow | null {
  return popover;
}

export function togglePopover(tray: Tray): void {
  if (!popover || popover.isDestroyed()) popover = createPopover();

  if (popover.isVisible()) {
    popover.hide();
    return;
  }

  const b = tray.getBounds();
  // Centered under the icon; tray bounds are in screen coordinates.
  const x = Math.round(b.x + b.width / 2 - WIDTH / 2);
  const y = process.platform === 'darwin'
    ? Math.round(b.y + b.height + 6)
    : Math.round(b.y - HEIGHT - 6); // Windows tray sits at the bottom
  popover.setPosition(x, y, false);
  popover.webContents.send('freeapi:refresh');
  popover.show();
  popover.focus();
}
