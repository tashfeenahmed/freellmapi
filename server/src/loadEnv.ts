import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root: from `server/src` (tsx) or `server/dist` (node start)
loadEnv({ path: path.resolve(__dirname, '../../.env') });
