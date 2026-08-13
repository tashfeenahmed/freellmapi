import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { createBackup } from '../../services/backups.js';

let dashToken = '';

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

describe('Backups API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
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
    expect(listed.body.total).toBe(1);
    expect(listed.body.items[0].filename).toBe(created.body.backup.filename);

    const restored = await request(app, 'POST', `/api/backups/${created.body.backup.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.success).toBe(true);

    const deleted = await request(app, 'DELETE', `/api/backups/${created.body.backup.id}`);
    expect(deleted.status).toBe(200);

    const after = await request(app, 'GET', '/api/backups?page=1&pageSize=20');
    expect(after.body.total).toBe(0);
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
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM backups').get()).toEqual({ n: 1 });
  });

  it('prefixes scheduled backups with auto-', async () => {
    const manual = await createBackup(getDb(), { tables: [], source: 'manual', backupPath: '' });
    expect(manual.filename).toMatch(/^backup-.*\.sql$/);

    const scheduled = await createBackup(getDb(), { tables: [], source: 'scheduled', backupPath: '' });
    expect(scheduled.filename).toMatch(/^auto-backup-.*\.sql$/);
  });
});
