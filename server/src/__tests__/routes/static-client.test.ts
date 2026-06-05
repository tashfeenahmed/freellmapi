import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

// CLIENT_DIST relocates the built dashboard for embedders (the desktop app
// ships client/dist in extraResources, out of reach of the default
// __dirname-relative path).
describe('CLIENT_DIST override', () => {
  let tmpDir: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-client-dist-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!doctype html><title>custom-dist</title>');
  });

  afterAll(() => {
    delete process.env.CLIENT_DIST;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves the SPA from the overridden directory', async () => {
    process.env.CLIENT_DIST = tmpDir;
    const app = createApp();
    const server = app.listen(0);
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    const html = await res.text();
    server.close();

    expect(res.status).toBe(200);
    expect(html).toContain('custom-dist');
  });
});
