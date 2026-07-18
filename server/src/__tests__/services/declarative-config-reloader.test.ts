import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeclarativeConfigReloader } from '../../services/declarative-config-reloader.js';

describe('declarative config reloader', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
    vi.restoreAllMocks();
  });

  it('applies an atomically replaced config file without restarting the process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-config-'));
    const configPath = path.join(dir, 'freellmapi.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ keys: [{ platform: 'groq', key: 'first' }] }));
    const applied: unknown[] = [];
    const reloader = createDeclarativeConfigReloader({
      configPath,
      debounceMs: 10,
      apply: (value) => { applied.push(value); },
    });
    cleanups.push(reloader.stop);

    await reloader.start();
    expect(applied).toHaveLength(1);

    const replacement = path.join(dir, 'replacement.json');
    fs.writeFileSync(replacement, JSON.stringify({ keys: [{ platform: 'groq', key: 'second' }] }));
    fs.renameSync(replacement, configPath);

    await vi.waitFor(() => expect(applied).toHaveLength(2), { timeout: 500 });
    expect(applied[1]).toEqual({ keys: [{ platform: 'groq', key: 'second' }] });
  });

  it('keeps the last good config when a replacement is invalid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-config-'));
    const configPath = path.join(dir, 'freellmapi.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ keys: [{ platform: 'groq', key: 'first' }] }));
    const applied: unknown[] = [];
    const onError = vi.fn();
    const reloader = createDeclarativeConfigReloader({
      configPath,
      debounceMs: 10,
      apply: (value) => { applied.push(value); },
      onError,
    });
    cleanups.push(reloader.stop);

    await reloader.start();
    fs.writeFileSync(configPath, '{ invalid json');

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 500 });
    expect(applied).toHaveLength(1);
    expect(reloader.status().lastError).toMatch(/JSON|Unexpected/);
  });
});
