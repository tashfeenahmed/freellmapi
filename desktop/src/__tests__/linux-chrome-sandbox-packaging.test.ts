import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// #1229: the Linux .deb ships chrome-sandbox as 755. Electron then aborts:
// "The SUID sandbox helper binary was found, but is not configured correctly.
// You need to make sure that /opt/FreeLLMAPI/chrome-sandbox is owned by root
// and has mode 4755." afterPack chmod's the helper before fpm packs the deb.

const yaml = createRequire(import.meta.url)('js-yaml');
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '../..');
const builderConfigPath = join(desktopRoot, 'electron-builder.yml');
const afterPackRel = './scripts/after-pack-linux-sandbox.mjs';
const afterPackPath = resolve(desktopRoot, afterPackRel);

describe('linux chrome-sandbox packaging (#1229)', () => {
  it('wires afterPack to a script that sets chrome-sandbox mode 4755', () => {
    const config = yaml.load(readFileSync(builderConfigPath, 'utf8')) as {
      afterPack?: string;
      linux?: { target?: Array<{ target?: string }> };
    };
    const linuxTargets = (config.linux?.target ?? []).map((entry) => entry.target);
    expect(linuxTargets).toContain('deb');
    expect(config.afterPack).toBe(afterPackRel);
    expect(existsSync(afterPackPath)).toBe(true);

    const source = readFileSync(afterPackPath, 'utf8');
    expect(source).toMatch(/chrome-sandbox/);
    expect(source).toMatch(/0o4755/);
  });

  describe('afterPack helper', () => {
    let directory: string;

    afterEach(() => {
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    async function loadHelper() {
      return import(pathToFileURL(afterPackPath).href) as Promise<{
        chmodLinuxChromeSandbox: (appOutDir: string) => void;
        default: (context: { electronPlatformName: string; appOutDir: string }) => Promise<void>;
      }>;
    }

    // Windows chmod/stat does not preserve Unix mode bits (0o755 → 0o666).
    it.skipIf(process.platform !== 'linux')('chmodSyncs a 0755 chrome-sandbox to 0o4755 on linux', async () => {
      const { chmodLinuxChromeSandbox, default: afterPack } = await loadHelper();
      directory = mkdtempSync(join(tmpdir(), 'linux-sandbox-'));
      const sandbox = join(directory, 'chrome-sandbox');
      writeFileSync(sandbox, 'fake-sandbox');
      // 0o755 — the mode electron-builder leaves the helper at today.
      chmodSync(sandbox, 0o755);
      expect(statSync(sandbox).mode & 0o7777).toBe(0o755);

      chmodLinuxChromeSandbox(directory);
      expect(statSync(sandbox).mode & 0o7777).toBe(0o4755);

      // Default hook is the electron-builder afterPack entry: linux only.
      chmodSync(sandbox, 0o755);
      await afterPack({ electronPlatformName: 'darwin', appOutDir: directory });
      expect(statSync(sandbox).mode & 0o7777).toBe(0o755);
      await afterPack({ electronPlatformName: 'linux', appOutDir: directory });
      expect(statSync(sandbox).mode & 0o7777).toBe(0o4755);
    });

    it('is a no-op when chrome-sandbox is absent', async () => {
      const { chmodLinuxChromeSandbox } = await loadHelper();
      directory = mkdtempSync(join(tmpdir(), 'linux-sandbox-missing-'));
      expect(() => chmodLinuxChromeSandbox(directory)).not.toThrow();
    });
  });
});
