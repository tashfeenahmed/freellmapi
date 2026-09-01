// Re-stamps latest-mac.yml after the DMG has been stapled.
//
// electron-builder hashes the DMG and writes latest-mac.yml as the very last
// thing it does for that target. Stapling the notarization ticket happens after
// electron-builder has exited and *rewrites the DMG in place*, so every byte
// count and checksum in that manifest is stale the moment the ticket lands.
//
// electron-updater verifies the sha512 from this manifest against the file it
// downloaded, so a stale hash doesn't degrade gracefully — it fails the update
// for every existing install. Recomputing here keeps the manifest describing
// the file users actually receive.
//
// Usage: node scripts/refresh-mac-update-metadata.mjs <dmg> <latest-mac.yml>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/** sha512, base64 — the encoding electron-updater compares against. */
export function hashFile(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

/**
 * Whether the manifest has an entry for `fileName`.
 *
 * The CLI checks this rather than "did the text change", because an unchanged
 * manifest is ambiguous: it means either that nothing matched (a real problem)
 * or that the recomputed hash equalled the old one (perfectly fine, and what
 * happens on any re-run over an already-stapled DMG).
 */
export function describesFile(yamlText, fileName) {
  return yamlText
    .split('\n')
    .some((line) => new RegExp(`^\\s*(-\\s+url|path):\\s*${escapeRegExp(fileName)}\\s*$`).test(line));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites the sha512/size that describe `fileName` in a latest-mac.yml.
 *
 * Deliberately a line-level edit rather than a YAML parse-and-dump: a round
 * trip through a YAML library reorders keys and restyles quoting, which would
 * make every release diff noisy and risks changing a field electron-updater
 * reads. Only the numbers that actually changed are touched.
 *
 * Both the `files:` entry and the legacy top-level `path`/`sha512` pair are
 * updated — old electron-updater builds read the top-level pair, current ones
 * read `files:`, and a release has to satisfy whichever one an installed copy
 * happens to use.
 */
export function rewriteUpdateMetadata(yamlText, { fileName, sha512, size }) {
  const lines = yamlText.split('\n');
  let inMatchingFileEntry = false;
  let topLevelPathMatches = false;

  const out = lines.map((line) => {
    // A `  - url: <name>` line opens a files[] entry; any other list item at
    // that indent closes the one we were in.
    const listItem = /^\s*-\s+url:\s*(.+?)\s*$/.exec(line);
    if (listItem) {
      inMatchingFileEntry = listItem[1] === fileName;
      return line;
    }

    // Top-level keys (column 0) end the files[] block entirely.
    if (/^\S/.test(line)) {
      const path = /^path:\s*(.+?)\s*$/.exec(line);
      if (path) topLevelPathMatches = path[1] === fileName;
      if (topLevelPathMatches) {
        if (/^sha512:/.test(line)) return `sha512: ${sha512}`;
        if (/^size:/.test(line)) return `size: ${size}`;
      }
      if (!/^(files|path|sha512|size):/.test(line)) inMatchingFileEntry = false;
      return line;
    }

    if (inMatchingFileEntry) {
      const indent = /^\s*/.exec(line)[0];
      if (/^\s*sha512:/.test(line)) return `${indent}sha512: ${sha512}`;
      if (/^\s*size:/.test(line)) return `${indent}size: ${size}`;
    }
    return line;
  });

  return out.join('\n');
}

// Only run the CLI when invoked directly, so the test can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [dmgPath, ymlPath] = process.argv.slice(2);
  if (!dmgPath || !ymlPath) {
    console.error('usage: refresh-mac-update-metadata.mjs <dmg> <latest-mac.yml>');
    process.exit(1);
  }
  const fileName = basename(dmgPath);
  const before = readFileSync(ymlPath, 'utf8');
  if (!describesFile(before, fileName)) {
    // Shipping a manifest that doesn't name the artifact means every installed
    // copy would be told to fetch a file whose hash it can't verify.
    console.error(`refresh-mac-update-metadata: nothing in ${ymlPath} describes ${fileName}`);
    process.exit(1);
  }
  const sha512 = hashFile(dmgPath);
  const size = statSync(dmgPath).size;
  writeFileSync(ymlPath, rewriteUpdateMetadata(before, { fileName, sha512, size }));
  console.log(`refresh-mac-update-metadata: ${fileName} -> size ${size}`);
}
