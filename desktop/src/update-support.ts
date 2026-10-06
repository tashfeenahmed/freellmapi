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
  | { phase: 'error'; message: string };

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

