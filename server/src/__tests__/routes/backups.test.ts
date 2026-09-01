import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { createBackup } from '../../services/backups.js';

let dashToken = '';
let dataDir = '';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function dumpPath(id: number): string {
  const row = getDb().prepare('SELECT filepath FROM backups WHERE id = ?').get(id) as { filepath: string };
  return row.filepath;
}

function modelCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n;
}

/** Everything above the first blank line: format, schema, key fingerprint and
 *  the table list restore validates before it touches a row. */
function headerOf(sql: string): string {
  return sql.slice(0, sql.indexOf('\n\n') + 2);
}

describe('Backups API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    // Backups anchor to the database's directory, so point the default DB path
    // at a scratch directory rather than writing dumps into the repo.
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-backups-'));
    process.env.FREEAPI_DB_PATH = path.join(dataDir, 'freeapi.db');
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  afterAll(() => {
    delete process.env.FREEAPI_DB_PATH;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists tables, creates a full backup, restores it, and deletes it', async () => {
    const tables = await request(app, 'GET', '/api/backups/tables');
    expect(tables.status).toBe(200);
    expect(Array.isArray(tables.body.tables)).toBe(true);
    expect(tables.body.tables).toContain('models');

    const created = await request(app, 'POST', '/api/backups', {});
    expect(created.status).toBe(201);
    expect(created.body.backup.id).toBeGreaterThan(0);
    expect(created.body.backup.isFull).toBe(true);

    const listed = await request(app, 'GET', '/api/backups?page=1&pageSize=20');
    expect(listed.status).toBe(200);
    expect(listed.body.items[0].filename).toBe(created.body.backup.filename);

    const restored = await request(app, 'POST', `/api/backups/${created.body.backup.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.success).toBe(true);
    // Restore always leaves an undo behind.
    expect(restored.body.snapshot.source).toBe('pre-restore');

    const deleted = await request(app, 'DELETE', `/api/backups/${created.body.backup.id}`);
    expect(deleted.status).toBe(200);

    const after = await request(app, 'GET', '/api/backups?page=1&pageSize=20');
    expect(after.body.items.some((item: { id: number }) => item.id === created.body.backup.id)).toBe(false);
  });

  it('round-trips the schedule setting', async () => {
    const put = await request(app, 'PUT', '/api/backups/schedule', {
      enabled: true,
      time: '04:15',
      intervalDays: 2,
      backupPath: '',
    });
    expect(put.status).toBe(200);
    expect(put.body.schedule).toMatchObject({ enabled: true, time: '04:15', intervalDays: 2, backupPath: '' });

    const get = await request(app, 'GET', '/api/backups/schedule');
    expect(get.status).toBe(200);
    expect(get.body.schedule).toMatchObject({ enabled: true, time: '04:15', intervalDays: 2 });
  });

  it('creates a partial backup with the requested tables', async () => {
    const created = await request(app, 'POST', '/api/backups', { tables: ['models'] });
    expect(created.status).toBe(201);
    expect(created.body.backup.isFull).toBe(false);
    expect(created.body.backup.tables).toEqual(['models']);
  });

  it('prefixes scheduled backups with auto-', () => {
    const manual = createBackup(getDb(), { tables: [], source: 'manual', backupPath: '' });
    expect(manual.filename).toMatch(/^backup-.*\.sql$/);

    const scheduled = createBackup(getDb(), { tables: [], source: 'scheduled', backupPath: '' });
    expect(scheduled.filename).toMatch(/^auto-backup-.*\.sql$/);
  });

  it('never dumps the accounts, sessions or URL-token tables', async () => {
    const tables = await request(app, 'GET', '/api/backups/tables');
    for (const excluded of ['users', 'sessions', 'url_tokens']) {
      expect(tables.body.tables).not.toContain(excluded);
    }

    // The dashboard session used by this test is a live row in both tables.
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBeGreaterThan(0);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBeGreaterThan(0);

    const created = await request(app, 'POST', '/api/backups', {});
    const sql = fs.readFileSync(dumpPath(created.body.backup.id), 'utf8');
    expect(sql).not.toMatch(/INSERT INTO "users"/);
    expect(sql).not.toMatch(/INSERT INTO "sessions"/);
    expect(sql).not.toMatch(/INSERT INTO "url_tokens"/);
    expect(sql).not.toMatch(/password_hash/);
    // Operator settings are still in there: that is what a backup is for.
    expect(sql).toMatch(/INSERT INTO "settings"/);

    // Asking for them explicitly does not smuggle them in either.
    const explicit = await request(app, 'POST', '/api/backups', { tables: ['users', 'models'] });
    expect(explicit.body.backup.tables).toEqual(['models']);
  });

  it('records the schema version and encryption-key fingerprint in the dump header', async () => {
    const created = await request(app, 'POST', '/api/backups', {});
    const sql = fs.readFileSync(dumpPath(created.body.backup.id), 'utf8');
    expect(sql).toMatch(/^-- format: 1$/m);
    expect(sql).toMatch(/^-- schema: \d+ migrations, latest \d{8}_\d{6}_[a-z0-9_]+\.ts$/m);
    expect(sql).toMatch(/^-- key-fingerprint: sha256:[0-9a-f]{16}$/m);
  });

  it('rolls a failed restore back and leaves the data intact', async () => {
    const created = await request(app, 'POST', '/api/backups', {});
    const file = dumpPath(created.body.backup.id);
    const before = modelCount();
    expect(before).toBeGreaterThan(0);

    // A dump that empties models and then hits an unknown column. Without a
    // transaction around the whole file the delete would stand.
    fs.writeFileSync(
      file,
      `${headerOf(fs.readFileSync(file, 'utf8'))}DELETE FROM "models";\nINSERT INTO "models" ("no_such_column") VALUES (1);\n`,
      'utf8',
    );

    const restored = await request(app, 'POST', `/api/backups/${created.body.backup.id}/restore`);
    expect(restored.status).toBe(400);
    expect(restored.body.error.message).toMatch(/rolled back/i);
    expect(modelCount()).toBe(before);
  });

  it('refuses a dump written under a different encryption key', async () => {
    const created = await request(app, 'POST', '/api/backups', {});
    const file = dumpPath(created.body.backup.id);
    const sql = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, sql.replace(/^-- key-fingerprint: .*$/m, '-- key-fingerprint: sha256:ffffffffffffffff'), 'utf8');

    const restored = await request(app, 'POST', `/api/backups/${created.body.backup.id}/restore`);
    expect(restored.status).toBe(409);
    expect(restored.body.error.message).toMatch(/ENCRYPTION_KEY/);
    expect(modelCount()).toBeGreaterThan(0);
  });

  it('refuses a dump taken at a different schema version', async () => {
    const created = await request(app, 'POST', '/api/backups', {});
    const file = dumpPath(created.body.backup.id);
    const sql = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, sql.replace(/^-- schema: .*$/m, '-- schema: 3 migrations, latest 20240101_000001_ancient.ts'), 'utf8');

    const restored = await request(app, 'POST', `/api/backups/${created.body.backup.id}/restore`);
    expect(restored.status).toBe(409);
    expect(restored.body.error.message).toMatch(/schema version/);
  });

  it('refuses a hand-edited dump that writes to the accounts table', async () => {
    const created = await request(app, 'POST', '/api/backups', {});
    const file = dumpPath(created.body.backup.id);
    const sql = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${sql}DELETE FROM "users";\n`, 'utf8');

    const restored = await request(app, 'POST', `/api/backups/${created.body.backup.id}/restore`);
    expect(restored.status).toBe(400);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBeGreaterThan(0);
  });

  it('rejects a backup path outside the database directory', async () => {
    for (const backupPath of ['../escape', '/tmp/freeapi-escape', '../../etc']) {
      const put = await request(app, 'PUT', '/api/backups/schedule', {
        enabled: false,
        time: '03:00',
        intervalDays: 1,
        backupPath,
      });
      expect(put.status).toBe(400);
      expect(put.body.error.message).toMatch(/database directory/);
    }
    expect(fs.existsSync(path.resolve(dataDir, '../escape'))).toBe(false);

    // A directory under the data directory is accepted.
    const ok = await request(app, 'PUT', '/api/backups/schedule', {
      enabled: false,
      time: '03:00',
      intervalDays: 1,
      backupPath: 'nightly',
    });
    expect(ok.status).toBe(200);
    expect(fs.existsSync(path.join(dataDir, 'nightly'))).toBe(true);
  });

  it('takes only an integer id on the download route', async () => {
    const bad = await request(app, 'GET', '/api/backups/12abc/download');
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('Invalid backup ID');
  });
});
