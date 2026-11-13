import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// A key label is free text, but the .env export writes it as a `# label`
// comment line and the CSV export writes it as one cell. A label containing a
// newline therefore injects STRUCTURE into the export: an attacker- (or
// paste-) crafted label like "shop\nOPENAI_KEY=..." produced an env file whose
// injected line the importer would load as a real key on re-import. Labels are
// now one line of text at write time, and the exports defensively collapse
// control characters for rows stored by older builds.

let dashToken = '';

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashToken}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function exportEnvText(app: Express): Promise<{ status: number; text: string }> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/export?format=env`, {
    headers: { Authorization: `Bearer ${dashToken}`, 'x-reauth-password': 'password123' },
  });
  const text = await res.text();
  server.close();
  return { status: res.status, text };
}

async function exportCsvText(app: Express): Promise<{ status: number; text: string }> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/export?format=csv`, {
    headers: { Authorization: `Bearer ${dashToken}`, 'x-reauth-password': 'password123' },
  });
  const text = await res.text();
  server.close();
  return { status: res.status, text };
}

describe('Key label — no newline injection into exports', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
  });

  it('collapses newlines in a label at create time so the .env export stays one comment line', async () => {
    const res = await post(app, '/api/keys', {
      platform: 'groq',
      key: 'gsk_realkey_123456',
      label: 'prod\nGROQ_KEY=injected',
    });
    expect(res.status).toBe(201);

    const { status, text } = await exportEnvText(app);
    expect(status).toBe(200);
    // The injected line must not exist as a live env assignment (a line that
    // is not a comment). A sanitized comment mentioning it is fine.
    expect(text.split('\n').filter(l => l === 'GROQ_KEY=injected')).toHaveLength(0);
    // ...and the export must still carry exactly one comment line plus one key.
    expect(text.split('\n').filter(l => l.startsWith('#'))).toEqual(['# prod GROQ_KEY=injected']);
    expect(text).toContain('GROQ_KEY=gsk_realkey_123456');
  });

  it('sanitizes a legacy row that already holds a newline before exporting .env', async () => {
    await post(app, '/api/keys', { platform: 'groq', key: 'gsk_realkey_123456', label: 'ok' });
    // Simulate a row stored by an older build: label written straight to the DB.
    getDb().prepare('UPDATE api_keys SET label = ?').run('evil\nOPENAI_KEY=sk-stolen');

    const { text } = await exportEnvText(app);
    expect(text.split('\n').filter(l => l === 'OPENAI_KEY=sk-stolen')).toHaveLength(0);
    expect(text.split('\n').filter(l => l.startsWith('#'))).toEqual(['# evil OPENAI_KEY=sk-stolen']);
  });

  it('keeps a label on one CSV record', async () => {
    await post(app, '/api/keys', { platform: 'groq', key: 'gsk_realkey_123456', label: 'two\nlines' });

    const { status, text } = await exportCsvText(app);
    expect(status).toBe(200);
    // header + exactly one data record, and the newline survived nowhere.
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).toContain('"two lines"');
  });

  it('sanitizes the label on the update route too', async () => {
    const created = await post(app, '/api/keys', { platform: 'groq', key: 'gsk_realkey_123456', label: 'before' });
    const id = (created.body as any).id;

    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as { port: number };
    const upd = await fetch(`http://127.0.0.1:${addr.port}/api/keys/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dashToken}` },
      body: JSON.stringify({ label: 'a\r\nBROKEN=1' }),
    });
    server.close();
    expect(upd.status).toBe(200);

    const row = getDb().prepare('SELECT label FROM api_keys WHERE id = ?').get(id) as { label: string };
    expect(row.label).toBe('a BROKEN=1');
  });

  it('trims and bounds labels like every other operator label', async () => {
    const res = await post(app, '/api/keys', {
      platform: 'groq',
      key: 'gsk_realkey_123456',
      label: `   ${'x'.repeat(300)}   `,
    });
    expect(res.status).toBe(201);
    const row = getDb().prepare('SELECT label FROM api_keys ORDER BY created_at DESC LIMIT 1').get() as { label: string };
    expect(row.label.length).toBeLessThanOrEqual(200);
    expect(row.label).toBe('x'.repeat(200));
  });
});
