import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// GLIXEL is served at /glixel under the dashboard's security model: public
// static code without secrets, with every byte of data behind the session-gated
// /api/* routes. These tests pin that down, plus path containment and the
// fallback when the app was not built.

function get(port: number, rawPath: string, opts: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const GLIXEL_INDEX = '<!doctype html><title>GLIXEL</title><div id="root"></div><script type="module" src="/glixel/assets/index-Gx1Gx2Gx.js"></script>';
const DASHBOARD_INDEX = '<!doctype html><title>Dashboard</title>';
const OUTSIDE_SECRET = 'outside-dist-' + 'q'.repeat(24);

async function start(): Promise<{ server: Server; port: number }> {
  const server = createApp().listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
  return { server, port: (server.address() as { port: number }).port };
}

describe('GET /glixel', () => {
  let root: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'glixel-static-'));
    const glixel = path.join(root, 'glixel');
    const client = path.join(root, 'client');
    fs.mkdirSync(path.join(glixel, 'assets'), { recursive: true });
    fs.mkdirSync(client, { recursive: true });
    fs.writeFileSync(path.join(glixel, 'index.html'), GLIXEL_INDEX);
    fs.writeFileSync(path.join(glixel, 'assets', 'index-Gx1Gx2Gx.js'), 'export const glixel = 1;\n');
    fs.writeFileSync(path.join(client, 'index.html'), DASHBOARD_INDEX);
    fs.writeFileSync(path.join(root, 'secret.txt'), OUTSIDE_SECRET); // sibling of the dist folder
    process.env.GLIXEL_DIST = glixel;
    process.env.CLIENT_DIST = client;
    ({ server, port } = await start());
  });

  afterAll(() => {
    server.close();
    delete process.env.GLIXEL_DIST;
    delete process.env.CLIENT_DIST;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['/glixel', '/glixel/', '/glixel/anything/deep'])('serves the GLIXEL shell at %s, revalidated', async (p) => {
    const res = await get(port, p);
    expect(res.status).toBe(200);
    expect(res.body).toBe(GLIXEL_INDEX);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('keeps the same security headers as the dashboard', async () => {
    const glixel = await get(port, '/glixel/');
    const dashboard = await get(port, '/');
    expect(glixel.headers['content-security-policy']).toBeTruthy();
    expect(glixel.headers['content-security-policy']).toBe(dashboard.headers['content-security-policy']);
    expect(glixel.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves hashed assets immutably and 404s a missing one instead of the shell', async () => {
    const asset = await get(port, '/glixel/assets/index-Gx1Gx2Gx.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const missing = await get(port, '/glixel/assets/missing-Zz9Zz9Zz.js');
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain('GLIXEL');
  });

  it.each([
    '/glixel/../secret.txt',
    '/glixel/..%2fsecret.txt',
    '/glixel/%2e%2e/secret.txt',
    '/glixel/assets/..%2f..%2fsecret.txt',
    '/glixel/%2e%2e%2f%2e%2e%2fpackage.json',
  ])('never serves files outside the dist folder: %s', async (p) => {
    const res = await get(port, p);
    expect(res.body).not.toContain(OUTSIDE_SECRET);
    expect(res.body).not.toContain('"name": "@freellmapi');
  });

  it('does not expose data: the session-gated APIs still require a session', async () => {
    expect((await get(port, '/api/providers')).status).toBe(401);
    expect((await get(port, '/api/providers', { headers: { Referer: `http://127.0.0.1:${port}/glixel/` } })).status).toBe(401);
    expect((await get(port, '/api/health')).status).toBe(401);
    const shaped = await get(port, '/glixel/api/providers');
    expect(shaped.body).toBe(GLIXEL_INDEX); // just the shell, never data
    const ok = await get(port, '/api/providers', { headers: { Authorization: `Bearer ${mintDashboardToken()}` } });
    expect(ok.status).toBe(200);
  });

  it('never puts server secrets in GLIXEL responses', async () => {
    const unified = getUnifiedApiKey();
    for (const p of ['/glixel', '/glixel/', '/glixel/assets/index-Gx1Gx2Gx.js', '/glixel/x']) {
      const res = await get(port, p);
      expect(res.body).not.toContain(unified);
      expect(res.body).not.toContain(process.env.ENCRYPTION_KEY!);
      expect(JSON.stringify(res.headers)).not.toContain(unified);
    }
  });

  it('only answers GET/HEAD with the shell', async () => {
    const post = await get(port, '/glixel/', { method: 'POST' });
    expect(post.body).not.toBe(GLIXEL_INDEX);
    const head = await get(port, '/glixel/', { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  it('leaves the dashboard unchanged', async () => {
    expect((await get(port, '/')).body).toBe(DASHBOARD_INDEX);
    expect((await get(port, '/models/providers')).body).toBe(DASHBOARD_INDEX);
    expect((await get(port, '/glixelish')).body).toBe(DASHBOARD_INDEX); // prefix match is by path segment
  });
});

describe('GET /glixel without a build', () => {
  it('falls through to the dashboard instead of failing', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glixel-missing-'));
    fs.writeFileSync(path.join(root, 'index.html'), DASHBOARD_INDEX);
    process.env.CLIENT_DIST = root;
    process.env.GLIXEL_DIST = path.join(root, 'not-built');
    const { server, port } = await start();
    try {
      const res = await get(port, '/glixel/');
      expect(res.status).toBe(200);
      expect(res.body).toBe(DASHBOARD_INDEX);
    } finally {
      server.close();
      delete process.env.CLIENT_DIST;
      delete process.env.GLIXEL_DIST;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
