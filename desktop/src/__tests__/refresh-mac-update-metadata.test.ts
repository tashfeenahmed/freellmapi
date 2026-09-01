import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs build script, no types
import { rewriteUpdateMetadata, describesFile } from '../../scripts/refresh-mac-update-metadata.mjs';

// Stapling the notarization ticket rewrites the DMG after electron-builder has
// already hashed it, so latest-mac.yml has to be re-stamped or electron-updater
// rejects the download for every installed copy. These cover the rewrite.

const sample = `version: 0.8.8
files:
  - url: FreeLLMAPI-0.8.8-arm64.dmg
    sha512: OLDHASH==
    size: 111
path: FreeLLMAPI-0.8.8-arm64.dmg
sha512: OLDHASH==
releaseDate: '2026-08-25T20:25:58.884Z'
`;

const fresh = { fileName: 'FreeLLMAPI-0.8.8-arm64.dmg', sha512: 'NEWHASH==', size: 222 };

describe('rewriteUpdateMetadata', () => {
  it('re-stamps both the files[] entry and the top-level pair', () => {
    const out = rewriteUpdateMetadata(sample, fresh);
    expect(out).toContain('    sha512: NEWHASH==');
    expect(out).toContain('    size: 222');
    expect(out).toContain('\nsha512: NEWHASH==');
    expect(out).not.toContain('OLDHASH');
    expect(out).not.toContain('111');
  });

  it('leaves every other field, and the formatting, alone', () => {
    const out = rewriteUpdateMetadata(sample, fresh).split('\n');
    expect(out[0]).toBe('version: 0.8.8');
    expect(out[1]).toBe('files:');
    expect(out[2]).toBe('  - url: FreeLLMAPI-0.8.8-arm64.dmg');
    expect(out[5]).toBe('path: FreeLLMAPI-0.8.8-arm64.dmg');
    // releaseDate keeps its quoting — a YAML round trip would have restyled it.
    expect(out[7]).toBe("releaseDate: '2026-08-25T20:25:58.884Z'");
  });

  it('only touches the entry whose url matches', () => {
    const twoFiles = `version: 0.8.8
files:
  - url: FreeLLMAPI-0.8.8-arm64.dmg
    sha512: OLDHASH==
    size: 111
  - url: FreeLLMAPI-0.8.8-x64.dmg
    sha512: OTHER==
    size: 999
path: FreeLLMAPI-0.8.8-arm64.dmg
sha512: OLDHASH==
`;
    const out = rewriteUpdateMetadata(twoFiles, fresh);
    expect(out).toContain('    sha512: OTHER==');
    expect(out).toContain('    size: 999');
    expect(out).not.toContain('OLDHASH');
  });

  it('does not touch the top-level pair when it names a different file', () => {
    const zipTopLevel = `version: 0.8.8
files:
  - url: FreeLLMAPI-0.8.8-arm64.dmg
    sha512: OLDHASH==
    size: 111
path: FreeLLMAPI-0.8.8-arm64.zip
sha512: ZIPHASH==
size: 333
`;
    const out = rewriteUpdateMetadata(zipTopLevel, fresh);
    expect(out).toContain('    sha512: NEWHASH==');
    expect(out).toContain('sha512: ZIPHASH==');
    expect(out).toContain('size: 333');
  });

  it('returns the input unchanged when nothing matches', () => {
    const out = rewriteUpdateMetadata(sample, { ...fresh, fileName: 'nope.dmg' });
    expect(out).toBe(sample);
  });

  it('is a no-op when the recomputed hash already matches', () => {
    // Re-running over an already-stapled DMG must be safe: identical output is
    // the expected result, not the "nothing matched" failure.
    const unchanged = rewriteUpdateMetadata(sample, {
      fileName: fresh.fileName,
      sha512: 'OLDHASH==',
      size: 111,
    });
    expect(unchanged).toBe(sample);
  });
});

describe('describesFile', () => {
  it('finds the artifact by its files[] url and by the top-level path', () => {
    expect(describesFile(sample, 'FreeLLMAPI-0.8.8-arm64.dmg')).toBe(true);
    expect(describesFile('path: FreeLLMAPI-0.8.8-arm64.dmg\n', 'FreeLLMAPI-0.8.8-arm64.dmg')).toBe(
      true,
    );
  });

  it('is false when the manifest names a different artifact', () => {
    expect(describesFile(sample, 'FreeLLMAPI-0.8.8-x64.dmg')).toBe(false);
  });

  it('does not match on a partial name', () => {
    // A bare `.includes` would match the x64 name inside the arm64 one.
    expect(describesFile(sample, '0.8.8-arm64.dmg')).toBe(false);
  });
});
