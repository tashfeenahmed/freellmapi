// Each macOS job hashes its final (including stapling) artifacts independently.
// Publish one manifest only after both jobs finish, otherwise --clobber makes
// the last job erase the other architecture's update entries.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { hashFile } from './refresh-mac-update-metadata.mjs';

export function mergeMacUpdateMetadata(arm64Directory, x64Directory) {
  const manifests = [];
  const files = [];
  for (const [arch, directory] of [['arm64', arm64Directory], ['x64', x64Directory]]) {
    const manifest = yaml.load(readFileSync(join(directory, 'latest-mac.yml'), 'utf8'), {
      schema: yaml.JSON_SCHEMA,
    });
    if (!manifest || typeof manifest.version !== 'string' || !Array.isArray(manifest.files)) {
      throw new Error(`Invalid ${arch} update manifest`);
    }
    if (manifests.length && manifest.version !== manifests[0].version) {
      throw new Error('macOS update manifests have different versions');
    }
    const extensions = new Set();
    for (const file of manifest.files) {
      const name = file?.url;
      if (typeof name !== 'string' || basename(name) !== name ||
          (!name.endsWith(`-${arch}.dmg`) && !name.endsWith(`-${arch}.zip`))) {
        throw new Error(`Unexpected ${arch} artifact: ${name}`);
      }
      if (files.some((entry) => entry.url === name)) {
        throw new Error(`Duplicate macOS artifact: ${name}`);
      }
      const artifactPath = join(directory, name);
      if (statSync(artifactPath).size !== file.size || hashFile(artifactPath) !== file.sha512) {
        throw new Error(`Hash or size mismatch for ${name}; refresh metadata after stapling`);
      }
      extensions.add(name.endsWith('.dmg') ? 'dmg' : 'zip');
      files.push(file);
    }
    if (!extensions.has('dmg') || !extensions.has('zip')) {
      throw new Error(`Missing ${arch} DMG or ZIP`);
    }
    if (!manifest.files.some((file) => file.url === manifest.path && file.sha512 === manifest.sha512)) {
      throw new Error(`Invalid ${arch} legacy path/sha512`);
    }
    manifests.push(manifest);
  }
  // Preserve the existing arm64 legacy fields. Modern clients select their
  // architecture from files[], which now contains both architectures.
  return yaml.dump({ ...manifests[0], files }, { lineWidth: -1 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [arm64Directory, x64Directory, outputPath] = process.argv.slice(2);
  if (!arm64Directory || !x64Directory || !outputPath) {
    throw new Error('usage: merge-mac-update-metadata.mjs <arm64 directory> <x64 directory> <output.yml>');
  }
  writeFileSync(outputPath, mergeMacUpdateMetadata(arm64Directory, x64Directory));
  console.log(`Merged and verified macOS update metadata: ${outputPath}`);
}
