import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasWorkspaceMarkers(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'package.json'))
    && fs.existsSync(path.join(dir, 'server', 'package.json'))
    && fs.existsSync(path.join(dir, 'client', 'package.json'));
}

function findProjectRoot(): string {
  const candidates = [process.cwd(), __dirname];
  for (const start of candidates) {
    let current = path.resolve(start);
    while (true) {
      if (hasWorkspaceMarkers(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  // Fallback: keep the old module-relative behavior if we cannot identify the
  // workspace root. This still works for package-only installs.
  return path.resolve(__dirname, '../..');
}

export const PROJECT_ROOT = findProjectRoot();

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath));
}

export function loadProjectEnv(
  projectRoot = PROJECT_ROOT,
  targetEnv: NodeJS.ProcessEnv = process.env,
): void {
  const merged = {
    ...parseEnvFile(path.resolve(projectRoot, '.env')),
    ...parseEnvFile(path.resolve(projectRoot, '.env.local')),
  };

  for (const [key, value] of Object.entries(merged)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }
}

export function resolveDbPathEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dbPath = env.DB_PATH?.trim();
  if (dbPath) return dbPath;

  const legacyPath = env.DATABASE_PATH?.trim();
  if (legacyPath) return legacyPath;

  return undefined;
}

export function resolveDatabaseUrlEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DATABASE_URL?.trim() || undefined;
}

export function resolveDefaultDbPath(projectRoot: string = PROJECT_ROOT): string {
  return path.resolve(projectRoot, 'server', 'data', 'freeapi.db');
}

loadProjectEnv();
