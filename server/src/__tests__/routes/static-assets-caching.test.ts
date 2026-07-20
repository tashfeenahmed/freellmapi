import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

// Raw node:http (not global fetch): undici transparently decompresses gzip and
// hides Content-Encoding, which would make the compression assertions below
// meaningless. node:http leaves the response bytes and headers untouched.
function get(
  port: number,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Vite emits content-hashed chunks (JS/CSS/fonts) under assets/. Fixtures are
// padded past compression's 1 KB threshold so gzip actually engages.
const BIG_JS = '// hashed bundle fixture\n' + 'export const chunk = 1;\n'.repeat(200);
const BIG_CSS = '/* hashed styles fixture */\n' + '.cls { color: #123456; }\n'.repeat(200);

describe('static SPA: gzip compression + asset cache headers', () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-static-cache-'));
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'index.html'),
      '<!doctype html><title>cache-fixture</title><script src="/assets/index-Ab3dE5fg.js"></script>',
    );
    fs.writeFileSync(path.join(tmpDir, 'assets', 'index-Ab3dE5fg.js'), BIG_JS);
    fs.writeFileSync(path.join(tmpDir, 'assets', 'index-Zz9Yx8w0.css'), BIG_CSS);
    // A non-index hashed chunk — guards against only special-casing index-*.
    fs.writeFileSync(path.join(tmpDir, 'assets', 'vendor-Q1w2E3r4.js'), BIG_JS);

    process.env.CLIENT_DIST = tmpDir;
    server = createApp().listen(0);
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    delete process.env.CLIENT_DIST;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gzips a static asset when the client accepts gzip', async () => {
    const res = await get(port, '/assets/index-Ab3dE5fg.js', { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
  });

  it('serves hashed assets with a long-lived immutable Cache-Control', async () => {
    for (const asset of [
      '/assets/index-Ab3dE5fg.js',
      '/assets/index-Zz9Yx8w0.css',
      '/assets/vendor-Q1w2E3r4.js', // not index-* — all hashed chunks covered
    ]) {
      const res = await get(port, asset);
      expect(res.status, asset).toBe(200);
      expect(res.headers['cache-control'], asset).toBe(
        'public, max-age=31536000, immutable',
      );
    }
  });

  it('does NOT mark index.html immutable so deploys propagate', async () => {
    const res = await get(port, '/index.html');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control'] ?? '').not.toContain('immutable');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves SPA deep links with the same no-cache policy as index.html', async () => {
    const res = await get(port, '/analytics');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('does NOT gzip API responses (SSE/proxy responses stay untouched)', async () => {
    // /v1/openapi.json is large (>1 KB) JSON served by an API router mounted
    // before the compression middleware — proof the middleware never wraps it.
    const res = await get(port, '/v1/openapi.json', { 'Accept-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(1024);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});
