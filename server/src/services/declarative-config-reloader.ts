import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface DeclarativeConfigReloaderStatus {
  source: string;
  fingerprint: string | null;
  lastAppliedAt: string | null;
  lastError: string | null;
}

export interface DeclarativeConfigReloaderOptions {
  configPath: string;
  debounceMs?: number;
  apply: (value: unknown, source: string) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export interface DeclarativeConfigReloader {
  start(): Promise<boolean>;
  stop(): void;
  reload(): Promise<boolean>;
  status(): DeclarativeConfigReloaderStatus;
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Watches a declarative JSON config directory so secret/config managers can
 * atomically replace the file without coupling themselves to this process.
 * The last successfully applied snapshot remains active when a replacement is
 * invalid or temporarily unavailable.
 */
export function createDeclarativeConfigReloader(
  options: DeclarativeConfigReloaderOptions,
): DeclarativeConfigReloader {
  const configPath = path.resolve(options.configPath);
  const source = configPath;
  const debounceMs = Math.max(0, options.debounceMs ?? 250);
  let watcher: fs.FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<boolean> | null = null;
  let needsReload = false;
  let state: DeclarativeConfigReloaderStatus = {
    source,
    fingerprint: null,
    lastAppliedAt: null,
    lastError: null,
  };

  const reportError = (error: unknown): void => {
    const normalized = errorFromUnknown(error);
    state = { ...state, lastError: normalized.message };
    options.onError?.(normalized);
  };

  const reload = async (): Promise<boolean> => {
    if (inFlight) {
      needsReload = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
        if (fingerprint === state.fingerprint) return false;
        const value = JSON.parse(raw) as unknown;
        await options.apply(value, source);
        state = {
          ...state,
          fingerprint,
          lastAppliedAt: new Date().toISOString(),
          lastError: null,
        };
        return true;
      } catch (error) {
        reportError(error);
        return false;
      } finally {
        inFlight = null;
        if (needsReload && running) {
          needsReload = false;
          scheduleReload();
        }
      }
    })();
    return inFlight;
  };

  const scheduleReload = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void reload();
    }, debounceMs);
  };

  return {
    async start(): Promise<boolean> {
      if (running) return false;
      running = true;
      watcher = fs.watch(path.dirname(configPath), (_event, filename) => {
        if (!filename || filename.toString() === path.basename(configPath)) scheduleReload();
      });
      watcher.on('error', reportError);
      return reload();
    },
    stop(): void {
      running = false;
      needsReload = false;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    },
    reload,
    status(): DeclarativeConfigReloaderStatus {
      return { ...state };
    },
  };
}
