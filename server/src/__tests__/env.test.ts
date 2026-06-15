import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectEnv, resolveDbPathEnv, resolveDatabaseUrlEnv, resolveDefaultDbPath } from '../env.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-env-'));
  tempDirs.push(dir);
  return dir;
}

describe('env loading', () => {
  it('prefers .env.local over .env without clobbering real process env values', () => {
    const projectRoot = makeTempProject();
    fs.writeFileSync(path.join(projectRoot, '.env'), [
      'ENCRYPTION_KEY=your-64-char-hex-key-here',
      'PORT=3001',
      'DATABASE_PATH=from-dot-env.db',
    ].join('\n'));
    fs.writeFileSync(path.join(projectRoot, '.env.local'), [
      `ENCRYPTION_KEY=${'a'.repeat(64)}`,
      'DATABASE_PATH=from-dot-env-local.db',
      'PORT=3002',
    ].join('\n'));

    const env = { PORT: '9000' } as NodeJS.ProcessEnv;
    loadProjectEnv(projectRoot, env);

    expect(env.PORT).toBe('9000');
    expect(env.ENCRYPTION_KEY).toBe('a'.repeat(64));
    expect(env.DATABASE_PATH).toBe('from-dot-env-local.db');
  });

  it('resolves the modern DB_PATH first and falls back to DATABASE_PATH', () => {
    expect(resolveDbPathEnv({ DB_PATH: 'modern.db', DATABASE_PATH: 'legacy.db' } as NodeJS.ProcessEnv)).toBe('modern.db');
    expect(resolveDbPathEnv({ DATABASE_PATH: 'legacy.db' } as NodeJS.ProcessEnv)).toBe('legacy.db');
    expect(resolveDbPathEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('resolves DATABASE_URL when present', () => {
    expect(resolveDatabaseUrlEnv({ DATABASE_URL: 'postgres://example' } as NodeJS.ProcessEnv)).toBe('postgres://example');
    expect(resolveDatabaseUrlEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('builds the default sqlite path under the workspace server/data directory', () => {
    const projectRoot = makeTempProject();
    const dbPath = resolveDefaultDbPath(projectRoot);
    expect(dbPath).toBe(path.join(projectRoot, 'server', 'data', 'freeapi.db'));
  });
});
