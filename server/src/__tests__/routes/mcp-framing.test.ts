import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey, setSetting } from '../../db/index.js';

// #1995: a client saw `transfer-encoding: chunked` on /mcp with a body that
// was not chunk-framed, so curl exited 56 and mcp-remote failed with
// "Invalid character in chunk size". fetch() hides framing, so these tests
// read the raw bytes off a socket and check that every /mcp reply is framed
// the way its headers say: Content-Length that matches the body, or valid
// chunks, never both and never neither.

let server: Server;
let port: number;

interface RawResponse {
  statusLine: string;
  headers: Array<[string, string]>;
  body: Buffer;
}

function rawRequest(method: string, path: string, opts: { body?: string; auth?: boolean; httpVersion?: '1.0' | '1.1' } = {}): Promise<RawResponse> {
  const body = opts.body ?? '';
  const lines = [
    `${method} ${path} HTTP/${opts.httpVersion ?? '1.1'}`,
    `Host: 127.0.0.1:${port}`,
    'Content-Type: application/json',
    'Accept: application/json, text/event-stream',
    ...(opts.auth === false ? [] : [`Authorization: Bearer ${getUnifiedApiKey()}`]),
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
  ];
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', c => chunks.push(c));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf('\r\n\r\n');
      if (split < 0) return reject(new Error(`no header terminator in ${JSON.stringify(raw.toString())}`));
      const [statusLine, ...headerLines] = raw.subarray(0, split).toString('latin1').split('\r\n');
      const headers = headerLines.map(l => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] as [string, string];
      });
      resolve({ statusLine, headers, body: raw.subarray(split + 4) });
    });
  });
}

/** Decode a chunked body strictly; throws on anything llhttp would reject. */
function decodeChunked(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) throw new Error('chunk size line not terminated');
    const sizeLine = buf.subarray(pos, eol).toString('latin1').split(';')[0];
    if (!/^[0-9a-fA-F]+$/.test(sizeLine)) throw new Error(`invalid chunk size ${JSON.stringify(sizeLine)}`);
    const size = parseInt(sizeLine, 16);
    pos = eol + 2;
    if (size === 0) {
      if (buf.subarray(pos).toString('latin1') !== '\r\n') throw new Error('bad last-chunk trailer');
      return Buffer.concat(out);
    }
    out.push(buf.subarray(pos, pos + size));
    pos += size;
    if (buf.subarray(pos, pos + 2).toString('latin1') !== '\r\n') throw new Error('chunk data not CRLF-terminated');
    pos += 2;
  }
}

/** Assert the response is validly framed and return its decoded body. */
function framedBody(res: RawResponse): string {
  const te = res.headers.filter(([k]) => k === 'transfer-encoding');
  const cl = res.headers.filter(([k]) => k === 'content-length');
  // RFC 9112 §6.1: a sender MUST NOT send Content-Length with Transfer-Encoding.
  expect(te.length > 0 && cl.length > 0).toBe(false);
  if (te.length > 0) {
    expect(te.map(([, v]) => v.toLowerCase()).join(',')).toBe('chunked');
    return decodeChunked(res.body).toString('utf8');
  }
  // Connection: close lets a body run to EOF, but the gateway always states
  // its length for JSON replies; require it so a framing regression shows up.
  expect(cl.length).toBe(1);
  expect(res.body.length).toBe(Number(cl[0][1]));
  return res.body.toString('utf8');
}

const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
});

describe('/mcp raw HTTP framing (#1995)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setSetting('enable_mcp', '1');
    server = createApp().listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  for (const httpVersion of ['1.1', '1.0'] as const) {
    it(`frames 200 initialize over HTTP/${httpVersion}`, async () => {
      const res = await rawRequest('POST', '/mcp', { body: INIT, httpVersion });
      expect(res.statusLine).toMatch(/^HTTP\/1\.1 200 /);
      const json = JSON.parse(framedBody(res));
      expect(json.result.protocolVersion).toBe('2025-06-18');
      expect(res.headers.find(([k]) => k === 'content-type')?.[1]).toMatch(/^application\/json/);
    });

    it(`frames the 401 over HTTP/${httpVersion}`, async () => {
      const res = await rawRequest('POST', '/mcp', { body: INIT, auth: false, httpVersion });
      expect(res.statusLine).toMatch(/^HTTP\/1\.1 401 /);
      expect(JSON.parse(framedBody(res)).error.code).toBe(-32001);
    });

    it(`never sends chunked to an HTTP/${httpVersion === '1.0' ? '1.0 client' : '1.1 client for a JSON reply'}`, async () => {
      const res = await rawRequest('POST', '/mcp', { body: INIT, httpVersion });
      expect(res.headers.some(([k]) => k === 'transfer-encoding')).toBe(false);
    });
  }

  it('frames 400, 202 and 405 replies', async () => {
    const bad = await rawRequest('POST', '/mcp', { body: '[]' });
    expect(bad.statusLine).toMatch(/ 400 /);
    expect(JSON.parse(framedBody(bad)).error.code).toBe(-32600);

    const note = await rawRequest('POST', '/mcp', { body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.statusLine).toMatch(/ 202 /);
    expect(framedBody(note)).toBe('');

    const get = await rawRequest('GET', '/mcp');
    expect(get.statusLine).toMatch(/ 405 /);
    expect(JSON.parse(framedBody(get)).error.code).toBe(-32000);
  });

  it('decodeChunked rejects the body shape reported in #1995', () => {
    expect(() => decodeChunked(Buffer.from('{"jsonrpc":"2.0","id":0}'))).toThrow(/chunk size/);
  });
});
