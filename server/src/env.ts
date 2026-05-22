import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `Missing required env var: ${name}. Add it to your .env file.`
    );
  }
  return val;
}

export function getDashboardEmail(): string {
  return requireEnv('DASHBOARD_EMAIL');
}

export function getDashboardPassword(): string {
  return requireEnv('DASHBOARD_PASSWORD');
}

export function getSessionSecret(): string {
  return requireEnv('SESSION_SECRET');
}
