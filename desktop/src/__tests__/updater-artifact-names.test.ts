import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The updater downloads the file latest*.yml names from the GitHub release.
// GitHub rewrites spaces in an uploaded asset's name to dots while
// electron-builder writes them into the manifest as dashes, so any installer
// name with a space is one the updater can never fetch (v0.13.4's
// "FreeLLMAPI.Setup.0.13.4.exe" vs latest.yml's "FreeLLMAPI-Setup-0.13.4.exe").

const yaml = createRequire(import.meta.url)('js-yaml');
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = yaml.load(readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8')) as Record<string, any>;

function expand(template: string): string {
  return template
    .replace('${productName}', config.productName)
    .replace('${version}', '1.2.3')
    .replace('${arch}', 'x64')
    .replace('${ext}', 'exe');
}

describe('updater artifact names', () => {
  it('gives every auto-updatable target a name without spaces', () => {
    for (const section of ['nsis', 'mac', 'appImage']) {
      const template = config[section]?.artifactName ?? config.artifactName;
      if (section === 'appImage' && !template) continue; // default "${productName}-${version}.${ext}"
      expect(template, section).toBeTypeOf('string');
      expect(expand(template), section).not.toMatch(/\s/);
    }
  });

  it('names the Windows installer the way latest.yml will', () => {
    expect(expand(config.nsis.artifactName)).toBe('FreeLLMAPI-Setup-1.2.3.exe');
  });
});
