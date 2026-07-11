import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

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

  it('initialize negotiates a supported protocol version and advertises tools', async () => {
    const { status, body } = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe('freellmapi');
  });

  it('falls back to the default protocol version for an unknown one', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  it('accepts notifications with a 202 and no body', async () => {
    const { status, body } = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(status).toBe(202);
    expect(body).toBeNull();
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
