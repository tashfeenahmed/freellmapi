import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../../cli/src/index.js';
import { getDb, initDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { resolveProvider } from '../../providers/index.js';
import { healthRouter } from '../../routes/health.js';
import { keysRouter } from '../../routes/keys.js';
import { modelsRouter } from '../../routes/models.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Exercise the CLI against real authenticated routes and encrypted storage.
// Only the upstream provider probe is replaced; no external credentials or calls.
describe('CLI provider keys through the dashboard API', () => {
  let server: Server;
  let url: string;
  let token: string;
  let output: string;
  const secret = 'gsk_cli_integration_secret==';
  const provider = resolveProvider('groq')!;

  beforeAll(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    token = mintDashboardToken();
    const app = express();
    app.use(express.json());
    app.use('/api/keys', requireAuth, keysRouter);
    app.use('/api/health', requireAuth, healthRouter);
    app.use('/api/models', requireAuth, modelsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM api_keys').run();
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
    vi.spyOn(provider, 'validateKey').mockResolvedValue(true);
  });

  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
  });

  const run = (...args: string[]) => main(['--url', url, '--token', token, 'keys', ...args]);

  it('adds, validates, lists, and removes a key without returning its credentials', async () => {
    expect(await run('add', 'groq', '--key', secret)).toBe(0);
    const row = getDb().prepare('SELECT * FROM api_keys').get() as {
      id: number; encrypted_key: string; iv: string; auth_tag: string; status: string;
    };
    expect(decrypt(row.encrypted_key, row.iv, row.auth_tag)).toBe(secret);
    expect(row.status).toBe('healthy');
    expect(provider.validateKey).toHaveBeenCalledWith(secret, expect.objectContaining({ keyId: row.id }));
    expect(await run('list')).toBe(0);
    expect(output).toContain('PLATFORM\tMODELS');
    expect(output).toContain('groq');
    expect(await run('remove', 'groq', '--id', String(row.id))).toBe(0);
    expect(getDb().prepare('SELECT * FROM api_keys').all()).toEqual([]);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
  });

  it('recognizes an inconclusive check despite the server preserving healthy status', async () => {
    await run('add', 'groq', '--key', secret);
    vi.mocked(provider.validateKey).mockRejectedValueOnce(new Error('network unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await run('test', 'groq')).toBe(1);
    expect(output).toContain('inconclusive (stored status: healthy)');
    expect(getDb().prepare('SELECT status FROM api_keys').get()).toEqual({ status: 'healthy' });
  });

  it('rejects a unified proxy key as dashboard authentication', async () => {
    const unified = getDb().prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string };
    await expect(main(['keys', 'list', '--url', url, '--token', unified.value]))
      .rejects.toThrow('Dashboard authentication failed');
    expect(output).toBe('');
  });
});
