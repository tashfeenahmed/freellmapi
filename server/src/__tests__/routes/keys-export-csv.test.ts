import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// FIX 3: CSV export must neutralize formula-injection in free-text labels. A
// label like `=HYPERLINK(...)` would run as a formula when the file is opened
// in Excel or Sheets; prefixing the cell with a single quote forces text.

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

describe('Keys CSV export — formula injection guard (FIX 3)', () => {
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

  it('prefixes formula-leading labels with a single quote', async () => {
    await post(app, '/api/keys', {
      platform: 'groq',
      key: 'gsk_realkey_123456',
      label: '=HYPERLINK("http://evil.example","click")',
    });

    const { status, text } = await exportCsvText(app);
    expect(status).toBe(200);

    const dataLine = text.trim().split('\n')[1]!;
    // The label cell is quoted; inside it the leading '=' is neutralized to "'=".
    expect(dataLine).toContain('"\'=HYPERLINK');
    // Sanity: the raw un-neutralized formula start is not present as a live cell.
    expect(dataLine).not.toContain(',"=HYPERLINK');
    // The real key value must round-trip verbatim (not neutralized).
    expect(dataLine).toContain('gsk_realkey_123456');
  });

  it('neutralizes the other risky lead characters (+, -, @, tab, CR) in labels', async () => {
    for (const [label, lead] of [
      ['+1+2', "'+"],
      ['-2+3', "'-"],
      ['@SUM(A1)', "'@"],
    ] as const) {
      getDb().prepare('DELETE FROM api_keys').run();
      await post(app, '/api/keys', { platform: 'groq', key: 'gsk_realkey_123456', label });
      const { text } = await exportCsvText(app);
      const dataLine = text.trim().split('\n')[1]!;
      expect(dataLine).toContain(`"${lead}`);
    }
  });

  it('leaves ordinary labels untouched', async () => {
    await post(app, '/api/keys', { platform: 'groq', key: 'gsk_realkey_123456', label: 'My Groq Key' });
    const { text } = await exportCsvText(app);
    const dataLine = text.trim().split('\n')[1]!;
    expect(dataLine).toContain('"My Groq Key"');
    expect(dataLine).not.toContain("'My Groq Key");
  });

  it('neutralizes formula-leading base_url cells too (free text like the label)', async () => {
    getDb().prepare('DELETE FROM api_keys').run();
    // A custom endpoint whose base_url opens with '=' — exactly the shape the
    // label guard covers. Without the guard the cell opens as a live formula
    // in Excel/Sheets and the base_url cannot round-trip (the importer only
    // strips the guard quote from labels). Stored directly because the custom
    // POST path URL-validates base_url; the export must guard the column
    // whatever wrote it (older build, restored backup, hand-edited DB).
    const { encrypt } = await import('../../lib/crypto.js');
    const enc = encrypt('sk-local-abc123');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, enabled, status)
      VALUES ('custom', 'evil endpoint', ?, ?, ?, '=HYPERLINK("http://evil.example","click")', 1, 'healthy')
    `).run(enc.encrypted, enc.iv, enc.authTag);

    const { status, text } = await exportCsvText(app);
    expect(status).toBe(200);
    const dataLine = text.trim().split('\n').find(l => l.includes('sk-local-abc123'))!;
    expect(dataLine).toContain('"\'=HYPERLINK');
    expect(dataLine).not.toContain(',"=HYPERLINK');
  });
});
