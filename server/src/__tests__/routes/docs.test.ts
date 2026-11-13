import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { openapiSpec } from '../../docs/openapi.js';

async function request(app: Express, method: string, path: string, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, { method, headers });
  const raw = await res.text();
  server.close();
  return { status: res.status, contentType: res.headers.get('content-type') || '', raw };
}

describe('OpenAPI docs routes', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('serves the spec as valid JSON at GET /v1/openapi.json', async () => {
    const { status, contentType, raw } = await request(app, 'GET', '/v1/openapi.json');
    expect(status).toBe(200);
    expect(contentType).toContain('application/json');

    const spec = JSON.parse(raw); // throws (fails the test) if not valid JSON
    expect(spec.openapi).toMatch(/^3\.0\./);
    expect(spec.info?.title).toBe('FreeLLMAPI');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it('serves the reference viewer as HTML at GET /v1/docs', async () => {
    const { status, contentType, raw } = await request(app, 'GET', '/v1/docs');
    expect(status).toBe(200);
    expect(contentType).toContain('text/html');
    // Self-hosted: the page fetches the local spec, not a CDN asset.
    expect(raw).toContain('openapi.json');
    expect(raw).not.toContain('unpkg.com');
    expect(raw).not.toContain('cdn.');
  });

  it('does not require an API key for the docs (they expose no secrets)', async () => {
    // No Authorization / x-api-key header supplied.
    const spec = await request(app, 'GET', '/v1/openapi.json');
    const page = await request(app, 'GET', '/v1/docs');
    expect(spec.status).toBe(200);
    expect(page.status).toBe(200);
  });

  // The spec is the product: every documented path must resolve to a real route.
  // A missing route returns 404; a present-but-unauthenticated route returns
  // 401/400. We assert "not 404" so the check is auth-agnostic.
  it('documents only paths that exist in the app router', async () => {
    const base = openapiSpec.servers[0].url; // "/"
    for (const [path, item] of Object.entries(openapiSpec.paths)) {
      for (const method of Object.keys(item as Record<string, unknown>)
        .filter(key => !key.startsWith('x-'))) {
        const operation = (item as Record<string, any>)[method];
        const optional = operation?.['x-optional-surface'] === true;
        const routePath = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
        const { status } = await request(app, method.toUpperCase(), routePath);
        if (!optional) {
          expect(status, `${method.toUpperCase()} ${routePath} should exist`).not.toBe(404);
        }
      }
    }
  });

  // GET /v1/usage used to be a phantom inherited from the fork's spec. It is
  // real now (#1568): an authenticated route, so it must answer 401 without a
  // key and must never 404.
  it('serves /v1/usage instead of 404ing on it', async () => {
    const { status } = await request(app, 'GET', '/v1/usage');
    expect(status).not.toBe(404);
  });

  it('has internally consistent $ref pointers', () => {
    const refs: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') refs.push(value);
          else walk(value);
        }
      }
    };
    walk(openapiSpec);

    const resolve = (ref: string): unknown => {
      if (!ref.startsWith('#/')) return undefined;
      return ref.slice(2).split('/').reduce<any>((acc, part) => (acc == null ? acc : acc[part]), openapiSpec);
    };

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(resolve(ref), `unresolved $ref: ${ref}`).toBeDefined();
    }
  });
});
