// Built to build/preload.cjs (CommonJS — the reliable preload format).
// Runs in the renderer before any page script: seeds the dashboard session
// token into localStorage so AuthGate's very first /api/auth/status call is
// authenticated. The token arrives via additionalArguments (process.argv),
// which avoids templating strings into executeJavaScript.
import { contextBridge, ipcRenderer } from 'electron';

const TOKEN_KEY = 'freellmapi_dashboard_token';
const arg = process.argv.find((a) => a.startsWith('--freeapi-token='));
if (arg) {
  try {
    window.localStorage.setItem(TOKEN_KEY, arg.slice('--freeapi-token='.length));
  } catch {
    // localStorage unavailable — the dashboard will show its login screen.
  }
}

// Lets the client adapt its chrome (drag region, traffic-light padding,
// no Sign out) when running inside the desktop shell.
contextBridge.exposeInMainWorld('__FREEAPI_DESKTOP__', true);

// `desktop` class on <html> activates the client's translucent backdrop
// (html.desktop in index.css). CAREFUL: for an http:// load the preload
// runs before the page's document is parsed — documentElement is null or
// a placeholder that the parser replaces — so the early add is best-effort
// (no-flash when it sticks) and MUST NOT throw, or the theme observer
// below would never register. The client re-adds the class itself at
// module load (App.tsx), so the effect never depends on the early add.
function applyDesktopClass() {
  document.documentElement?.classList.add('desktop');
}
try {
  applyDesktopClass();
} catch {
  // Document not ready — DOMContentLoaded below covers it.
}

// Mirror the dashboard's theme to the main process so the tray popover
// matches. The dashboard expresses its theme as the `dark` class on
// documentElement (set by the early script in index.html and toggled by
// the navbar) — observe that class rather than reaching across worlds
// into localStorage.
function reportTheme() {
  ipcRenderer.send(
    'freeapi:theme-changed',
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  );
}
window.addEventListener('DOMContentLoaded', () => {
  applyDesktopClass();
  reportTheme();
  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
});
