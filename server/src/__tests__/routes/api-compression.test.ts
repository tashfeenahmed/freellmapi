import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import compression from 'compression';
import type { Server } from 'node:http';
import { apiCompressionFilter } from '../../app.js';

let server: Server;
let base = '';
const big = { data: 'x'.repeat(5000) };

beforeAll(async () => {
  const app = express();
  app.use('/api', compression({ filter: apiCompressionFilter }));
  app.use('/v1', compression({ filter: apiCompressionFilter }));
  app.get('/api/json', (_req, res) => { res.json(big); });
  app.get('/api/sse', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write(`data: ${'y'.repeat(5000)}\n\n`);
    res.end();
  });
  app.get('/v1/json', (_req, res) => { res.json(big); });
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { server.close(); });

const get = (p: string) => fetch(base + p, { headers: { 'Accept-Encoding': 'gzip' } });

describe('/api compression filter', () => {
  it('gzips /api JSON above the threshold', async () => {
    const res = await get('/api/json');
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(await res.json()).toEqual(big);
  });
  it('does not compress SSE under /api', async () => {
    const res = await get('/api/sse');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toContain('data: ');
  });
  it('does not compress /v1 responses', async () => {
    const res = await get('/v1/json');
    expect(res.headers.get('content-encoding')).toBeNull();
  });
});
