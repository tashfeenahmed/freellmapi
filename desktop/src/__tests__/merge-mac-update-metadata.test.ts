import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
// @ts-expect-error -- plain .mjs build script, no types
import { mergeMacUpdateMetadata } from '../../scripts/merge-mac-update-metadata.mjs';
// @ts-expect-error -- plain .mjs build script, no types
import { hashFile, rewriteUpdateMetadata } from '../../scripts/refresh-mac-update-metadata.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');

describe('macOS release metadata', () => {
  let directory: string;
  let arm64: string;
  let x64: string;

  function fixture(arch: string) {
    const dir = join(directory, arch);
    mkdirSync(dir);
    const files = ['zip', 'dmg'].map((extension) => {
      const url = `FreeLLMAPI-0.10.0-${arch}.${extension}`;
      const bytes = Buffer.from(`${arch} ${extension} package`);
      writeFileSync(join(dir, url), bytes);
      return { url, sha512: hashFile(join(dir, url)), size: bytes.length };
    });
    writeFileSync(join(dir, 'latest-mac.yml'), yaml.dump({
      version: '0.10.0', files, path: files[0].url, sha512: files[0].sha512,
      releaseDate: '2026-09-15T12:00:00.000Z',
    }, { lineWidth: -1 }));
    return dir;
  }

  function changeManifest(dir: string, update: (manifest: any) => void) {
    const path = join(dir, 'latest-mac.yml');
    const manifest = yaml.load(readFileSync(path, 'utf8'));
    update(manifest);
    writeFileSync(path, yaml.dump(manifest, { lineWidth: -1 }));
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mac-metadata-test-'));
    arm64 = fixture('arm64');
    x64 = fixture('x64');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('includes both architectures without losing the legacy ZIP or release date', () => {
    const merged: any = yaml.load(mergeMacUpdateMetadata(arm64, x64));
    expect(merged.files.map((file: any) => file.url)).toEqual([
      'FreeLLMAPI-0.10.0-arm64.zip', 'FreeLLMAPI-0.10.0-arm64.dmg',
      'FreeLLMAPI-0.10.0-x64.zip', 'FreeLLMAPI-0.10.0-x64.dmg',
    ]);
    expect(merged.path).toBe('FreeLLMAPI-0.10.0-arm64.zip');
    expect(merged.sha512).toBe(merged.files[0].sha512);
    expect(merged.releaseDate).toBe('2026-09-15T12:00:00.000Z');
  });

  it('accepts a stapled DMG only after its hash and size have been refreshed', () => {
    const fileName = 'FreeLLMAPI-0.10.0-x64.dmg';
    const bytes = Buffer.from('Intel DMG with its new notarization ticket');
    const path = join(x64, fileName);
    writeFileSync(path, bytes);
    expect(() => mergeMacUpdateMetadata(arm64, x64)).toThrow('Hash or size mismatch');
    const manifestPath = join(x64, 'latest-mac.yml');
    const sha512 = hashFile(path);
    writeFileSync(manifestPath, rewriteUpdateMetadata(readFileSync(manifestPath, 'utf8'), {
      fileName, sha512, size: bytes.length,
    }));
    const merged: any = yaml.load(mergeMacUpdateMetadata(arm64, x64));
    expect(merged.files.find((file: any) => file.url === fileName)).toEqual({
      url: fileName, sha512, size: bytes.length,
    });
  });

  it('rejects a checksum mismatch even when the file length is unchanged', () => {
    const path = join(x64, 'FreeLLMAPI-0.10.0-x64.zip');
    writeFileSync(path, Buffer.alloc(readFileSync(path).length));
    expect(() => mergeMacUpdateMetadata(arm64, x64)).toThrow('Hash or size mismatch');
  });

  it('rejects mismatched releases', () => {
    changeManifest(x64, (manifest) => { manifest.version = '0.9.9'; });
    expect(() => mergeMacUpdateMetadata(arm64, x64)).toThrow('different versions');
  });

  it('requires a ZIP and DMG for each architecture', () => {
    changeManifest(x64, (manifest) => { manifest.files.pop(); });
    expect(() => mergeMacUpdateMetadata(arm64, x64)).toThrow('Missing x64 DMG or ZIP');
  });

  it('rejects duplicate artifacts', () => {
    changeManifest(x64, (manifest) => { manifest.files.push(manifest.files[0]); });
    expect(() => mergeMacUpdateMetadata(arm64, x64)).toThrow('Duplicate macOS artifact');
  });

  it('rejects a manifest from the wrong architecture', () => {
    expect(() => mergeMacUpdateMetadata(arm64, arm64)).toThrow('Unexpected x64 artifact');
  });

  it('requires the legacy checksum to match its artifact', () => {
    changeManifest(arm64, (manifest) => { manifest.sha512 = 'stale'; });
    expect(() => mergeMacUpdateMetadata(arm64, x64)).toThrow('Invalid arm64 legacy path/sha512');
  });

  it('fails when an architecture was not downloaded', () => {
    rmSync(join(x64, 'latest-mac.yml'));
    expect(() => mergeMacUpdateMetadata(arm64, x64)).toThrow();
  });
});
