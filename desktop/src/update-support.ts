// Pure helpers for updater.ts, kept free of Electron imports so they can be
// unit-tested in plain Node.
import fs from 'node:fs';
import path from 'node:path';

export type UpdateState =
  | { phase: 'unsupported'; reason: 'dev' | 'package' }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; checkedAt: string }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  /** `during` says which step failed, so the UI can word it ("could not check" vs "could not install"). */
  | { phase: 'error'; during: 'check' | 'download' | 'install'; message: string };

/**
 * Whether this copy of the app can replace itself. Only an installed build
 * can: the Windows NSIS install (it ships an uninstaller next to the exe; the
 * portable .zip does not), a mac .app that is not running from the mounted dmg,
 * and the Linux AppImage. deb/rpm/tar.xz belong to the package manager.
 * FREEAPI_UPDATE_FEED lets an unpackaged build exercise the real flow against
 * a local feed during development.
 */
export function updateSupport(
  env: { isPackaged: boolean; platform: NodeJS.Platform; execPath: string; appImage?: string; feed?: string; productName: string },
  exists: (file: string) => boolean = fs.existsSync,
): UpdateState | null {
  if (!env.isPackaged && !env.feed) return { phase: 'unsupported', reason: 'dev' };
  if (env.feed) return null;
  if (env.platform === 'darwin') {
    return env.execPath.startsWith('/Volumes/') ? { phase: 'unsupported', reason: 'package' } : null;
  }
  if (env.platform === 'win32') {
    const uninstaller = path.join(path.dirname(env.execPath), `Uninstall ${env.productName}.exe`);
    return exists(uninstaller) ? null : { phase: 'unsupported', reason: 'package' };
  }
  if (env.platform === 'linux') return env.appImage ? null : { phase: 'unsupported', reason: 'package' };
  return { phase: 'unsupported', reason: 'package' };
}


/**
 * Turn the app's outbound proxy URL into what Electron's session.setProxy
 * takes (#1432). The updater runs on Chromium's network stack, which never
 * reads the dashboard proxy or HTTPS_PROXY, so on a network that only lets
 * traffic out through that proxy every check died with net::ERR_ABORTED while
 * curl (and the rest of the app) went through fine. Chromium takes the
 * credentials separately, through the updater's 'login' event, so they are
 * split off here. Returns null for an empty or unparseable URL, which leaves
 * the session on the system proxy settings.
 */
export function updaterProxy(url: string): { rules: string; username: string; password: string } | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Chromium knows socks4/socks5 and always resolves names through a SOCKS
  // proxy, so the "a"/"h" (remote DNS) spellings map onto the plain ones.
  const scheme = ({ 'socks5h:': 'socks5', 'socks:': 'socks5', 'socks4a:': 'socks4' } as Record<string, string>)[parsed.protocol]
    ?? parsed.protocol.slice(0, -1);
  if (!['http', 'https', 'socks4', 'socks5'].includes(scheme) || !parsed.hostname) return null;
  const port = parsed.port || (scheme === 'https' ? '443' : scheme === 'http' ? '80' : '1080');
  return {
    rules: `${scheme}://${parsed.host.replace(/:\d+$/, '')}:${port}`,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}
