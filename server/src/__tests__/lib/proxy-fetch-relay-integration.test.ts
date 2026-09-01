import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyProxyEnabled,
  applyProxyMode,
  applyProxyUrl,
  applyFetchRelayToken,
  FETCH_RELAY_AUTH_HEADER,
  FETCH_RELAY_TARGET_HEADER,
  proxyFetch,
} from '../../lib/proxy.js';

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

describe('fetch-relay local smoke test', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    applyProxyMode('forward');
    applyProxyUrl('');
    applyFetchRelayToken('');
    delete process.env.FREEAPI_PROXY_LOCAL_DESTINATIONS;
    await Promise.all(servers.splice(0).map(close));
  });

  it('round-trips JSON and exposes the first SSE chunk before the stream ends', async () => {
    let sseResponse: http.ServerResponse | undefined;
    const upstream = http.createServer(async (req, res) => {
      if (req.url === '/sse') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: first\n\n');
        sseResponse = res;
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    servers.push(upstream);
    const upstreamUrl = await listen(upstream);

    const relay = http.createServer(async (req, res) => {
      if (req.headers[FETCH_RELAY_AUTH_HEADER] !== 'Bearer integration-secret') {
        res.writeHead(401).end('unauthorized');
        return;
      }
      const target = req.headers[FETCH_RELAY_TARGET_HEADER];
      if (typeof target !== 'string') {
        res.writeHead(400).end('missing target');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      headers.delete(FETCH_RELAY_TARGET_HEADER);
      headers.delete(FETCH_RELAY_AUTH_HEADER);
      headers.delete('host');
      headers.delete('content-length');
      const upstreamResponse = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        redirect: 'manual',
      });
      res.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers));
      if (!upstreamResponse.body) {
        res.end();
        return;
      }
      const reader = upstreamResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    });
    servers.push(relay);
    const relayUrl = await listen(relay);

    process.env.FREEAPI_PROXY_LOCAL_DESTINATIONS = 'true';
    applyProxyEnabled(true);
    applyProxyUrl(relayUrl);
    applyProxyMode('fetch-relay');
    applyFetchRelayToken('integration-secret');

    const jsonResponse = await proxyFetch(`${upstreamUrl}/echo`, {
      method: 'POST',
      headers: { Authorization: 'Bearer smoke-key', 'Content-Type': 'application/json' },
      body: '{"hello":"relay"}',
    }, 'groq');
    expect(await jsonResponse.json()).toEqual({
      method: 'POST',
      authorization: 'Bearer smoke-key',
      body: '{"hello":"relay"}',
    });

    const streamResponse = await proxyFetch(`${upstreamUrl}/sse`, undefined, 'groq');
    const reader = streamResponse.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('first SSE chunk was buffered')), 1_000)),
    ]);
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');

    sseResponse!.end('data: second\n\n');
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: second\n\n');
  });
});
