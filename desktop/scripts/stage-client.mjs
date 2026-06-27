// Stages the built web client into desktop/client-dist so electron-builder can
// pick it up via a path *inside* the app dir.
//
// Why: electron-builder's extraResources used `from: ../client/dist`. That `../`
// reaches above desktop/, and on Windows it makes electron-builder treat the repo
// root as a copy base and then reject every repo-root file with
// "<file> must be under .../desktop/" (.dockerignore, .env.example, ...). Copying
// the client build into desktop/ first keeps every electron-builder path under
// desktop/ and sidesteps the whole class of errors cross-platform.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, '../../client/dist');
const dest = path.resolve(__dirname, '../client-dist');

if (!fs.existsSync(src)) {
  console.error(`stage-client: ${src} not found — build the web client first (npm run build -w client).`);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`stage-client: copied ${src} -> ${dest}`);
