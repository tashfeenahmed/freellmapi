import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';

let app: Express;

async function rpc(message: unknown, opts: { auth?: boolean } = {}) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.auth === false ? {} : { Authorization: `Bearer ${getUnifiedApiKey()}` }),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 202 empty */ }
  return { status: res.status, body: json };
}

function toolResultJson(body: any): any {
  expect(body.result?.content?.[0]?.type).toBe('text');
  return JSON.parse(body.result.content[0].text);
}

describe('MCP server (/mcp, stateless Streamable HTTP)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  it('rejects requests without the unified key', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { auth: false });
    expect(status).toBe(401);
    expect(body.error.code).toBe(-32001);
  });

  it('initialize always negotiates 2025-06-18 (batch-free transport) and advertises tools', async () => {
    // Echoing an older requested revision (2025-03-26 allowed batching) while
    // the transport rejects batches promised clients something they never got.
    const { status, body } = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe('freellmapi');

    const unknown = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(unknown.body.result.protocolVersion).toBe('2025-06-18');
  });

  it('accepts notifications with a 202 and no body', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(status).toBe(202);
    expect(body).toBeNull();
  });

  it('a notification is any message without an id — never answered, even for regular methods', async () => {
    // JSON-RPC 2.0: no `id` member = notification. Detecting notifications by
    // the method prefix answered no-id pings, which violates the spec.
    const { status, body } = await rpc({ jsonrpc: '2.0', method: 'ping' });
    expect(status).toBe(202);
    expect(body).toBeNull();
  });

  it('echoes id:0 (falsy ids must not collapse to null)', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 0, method: 'ping' });
    expect(body.id).toBe(0);
    expect(body.result).toEqual({});
  });

  it('echoes the request id on auth failures', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', id: 42, method: 'tools/list' }, { auth: false });
    expect(status).toBe(401);
    expect(body.id).toBe(42);
  });

  it('prototype-key tool names are unknown tools, not confusing tool errors', async () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const { body } = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name } });
      expect(body.error?.code).toBe(-32602);
    }
  });

  it('a prototype-key usage range falls back to 24h instead of throwing', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'usage_summary', arguments: { range: 'constructor' } },
    });
    expect(body.result.isError).toBeUndefined();
    expect(toolResultJson(body).range).toBe('24h');
  });

  it('usage_summary counts rows stored in SQLite datetime format (boundary day included)', async () => {
    // Regression: the ISO 'T' in the since-param sorted GREATER than every
    // same-day SQLite-format row (space < 'T'), so the window's boundary day
    // was silently dropped and "24h" behaved like "since UTC midnight".
    const db = getDb();
    // 23h old: still inside the 24h window but (almost always) on the same
    // UTC date as the since-boundary — exactly the rows the bug dropped.
    const boundaryDayRow = new Date(Date.now() - 23 * 3600_000);
    const sqlite = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, created_at)
                VALUES ('groq', 'test-model', 'success', 100, 50, ?)`).run(sqlite(boundaryDayRow));
    const hour = sqlite(boundaryDayRow).slice(0, 13) + ':00:00';
    db.prepare(`INSERT INTO request_hourly (hour, total_requests, success_count, input_tokens, output_tokens)
                VALUES (?, 1, 1, 100, 50)
                ON CONFLICT(hour) DO UPDATE SET total_requests = total_requests + 1`).run(hour);

    const { body } = await rpc({
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'usage_summary', arguments: { range: '24h' } },
    });
    const data = toolResultJson(body);
    expect(data.requests).toBeGreaterThanOrEqual(1);
    expect(data.top_models.some((m: any) => m.model_id === 'test-model')).toBe(true);
  });

  it('lists the six gateway tools with schemas', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['cache_stats', 'list_models', 'provider_health', 'routing_info', 'set_routing_strategy', 'usage_summary']);
    for (const tool of body.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('list_models returns catalog entries with supported_parameters', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'list_models', arguments: { available_only: false } },
    });
    const data = toolResultJson(body);
    expect(data.count).toBeGreaterThan(0);
    expect(data.auto.id).toBe('auto');
    const model = data.models[0];
    expect(model.id).toBeTruthy();
    expect(Array.isArray(model.supported_parameters)).toBe(true);
    expect(model.supported_parameters).toContain('temperature');
  });

  it('set_routing_strategy switches and routing_info reflects it', async () => {
    const set = await rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'set_routing_strategy', arguments: { strategy: 'fastest' } },
    });
    expect(toolResultJson(set.body)).toEqual({ strategy: 'fastest' });

    const info = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'routing_info' } });
    expect(toolResultJson(info.body).strategy).toBe('fastest');
  });

  it('an invalid strategy is a tool-level error, not a protocol error', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'set_routing_strategy', arguments: { strategy: 'chaotic' } },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('strategy must be one of');
  });

  it('usage_summary and provider_health and cache_stats answer on an empty install', async () => {
    for (const name of ['usage_summary', 'provider_health', 'cache_stats']) {
      const { body } = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name } });
      expect(body.result.content[0].type).toBe('text');
      expect(body.result.isError).toBeUndefined();
    }
  });

  it('unknown tool and unknown method return JSON-RPC errors', async () => {
    const tool = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'rm_rf' } });
    expect(tool.body.error.code).toBe(-32602);
    const method = await rpc({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
    expect(method.body.error.code).toBe(-32601);
  });

  it('rejects batches and non-request bodies', async () => {
    const batch = await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(batch.status).toBe(400);
    const junk = await rpc({ hello: 'world' });
    expect(junk.status).toBe(400);
  });

  it('GET /mcp is 405 (stateless: no server-initiated stream)', async () => {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`);
    server.close();
    expect(res.status).toBe(405);
  });
});
