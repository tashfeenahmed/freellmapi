import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { platformChrome } from './window-chrome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dashboardWindow: BrowserWindow | null = null;

export function getDashboardWindow(): BrowserWindow | null {
  return dashboardWindow;
}

// One window at a time, destroyed on close — the app lives in the tray, the
// window is an on-demand view. The session token rides in via
// additionalArguments so the CJS preload can seed localStorage before any
// page script runs (no login flash, no reload).
export function openDashboard(port: number, token: string): void {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'FreeLLMAPI',
    ...platformChrome(process.platform),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // The dashboard has no other way to know which build is running: the
      // server's own package version is not the released app version (#703).
      additionalArguments: [`--freeapi-token=${token}`, `--freeapi-version=${app.getVersion()}`],
    },
  });

  dashboardWindow.loadURL(`http://127.0.0.1:${port}`);
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}
