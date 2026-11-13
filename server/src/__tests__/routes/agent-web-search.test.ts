import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Agent web search (#1174): Claude Code's Anthropic `web_search_*` server tool
// and Codex's Responses `web_search` tool are answered from the gateway's
// search pool. runSearch is mocked; the routed model is a mocked Groq upstream
// that first calls `web_search`, then answers.

const runSearchMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/search.js')>();
  return { ...actual, runSearch: runSearchMock };
});

import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { encodeHitContent, filterHitsByDomain } from '../../lib/web-search-tool.js';
import { seedSearchEngines } from '../helpers/search-engines.js';

let app: Express;
let dashToken = '';

async function post(path: string, body: any, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, text, body: json };
}

function sseEvents(text: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const block of text.split('\n\n')) {
    let event: string | null = null;
    let data: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event && data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

const anthropicHeaders = () => ({ 'x-api-key': getUnifiedApiKey(), 'anthropic-version': '2023-06-01' });
const bearer = () => ({ Authorization: `Bearer ${getUnifiedApiKey()}` });

const searchCall = (query: string, id = 'call_s1') => ({
  id: 'chatcmpl-s', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
  choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
});
const answer = (text: string) => ({
  id: 'chatcmpl-a', object: 'chat.completion', created: 1, model: 'openai/gpt-oss-120b',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
});

/** Mock Groq with a queue of JSON chat completions; captures forwarded bodies. */
function mockGroq(responses: any[]) {
  const bodies: any[] = [];
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('api.groq.com/openai/v1/chat/completions')) {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      const next = responses.shift();
      if (!next) throw new Error('no mocked Groq response left');
      return { ok: true, json: () => Promise.resolve(next) } as any;
    }
    return origFetch(url as any, init);
  });
  return bodies;
}

const HITS = [
  { title: 'Release notes', url: 'https://example.com/news/1', content: 'Version 9 shipped on Monday.', score: 0.9 },
  { title: 'Blog', url: 'https://blocked.test/post', content: 'Unrelated.', score: 0.5 },
];

function addSearchKey() {
  const { encrypted, iv, authTag } = encrypt('tvly-test');
  getDb().prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('tavily', 't', ?, ?, ?, 'healthy', 1)")
    .run(encrypted, iv, authTag);
}

describe('agent web search served from the search pool', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedSearchEngines();
    app = createApp();
    dashToken = mintDashboardToken();
    setSetting('enable_mcp', '1');
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('expose_cc_discovery_aliases', '0')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    const { status } = await post('/api/keys', { platform: 'groq', key: 'gsk_web_search_test', label: 'g' }, { Authorization: `Bearer ${dashToken}` });
    expect(status).toBe(201);
    runSearchMock.mockReset();
    runSearchMock.mockResolvedValue({ query: 'q', results: HITS, provider: 'tavily', engine: 'tavily-search', modelId: 'search' });
  });

  afterEach(() => vi.restoreAllMocks());

  describe('Anthropic web_search server tool', () => {
    const request = (extra: Record<string, unknown> = {}) => ({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'What shipped this week?' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      ...extra,
    });

    it('runs the search and returns server_tool_use + web_search_tool_result blocks', async () => {
      addSearchKey();
      const bodies = mockGroq([searchCall('version 9 release'), answer('Version 9 shipped on Monday.')]);
      const { status, body } = await post('/v1/messages', request(), anthropicHeaders());

      expect(status).toBe(200);
      expect(runSearchMock).toHaveBeenCalledTimes(1);
      expect(runSearchMock.mock.calls[0][0]).toBe('version 9 release');
      const types = body.content.map((b: any) => b.type);
      expect(types).toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
      const [use, result, text] = body.content;
      expect(use.id).toMatch(/^srvtoolu_/);
      expect(use).toMatchObject({ name: 'web_search', input: { query: 'version 9 release' } });
      expect(result.tool_use_id).toBe(use.id);
      expect(result.content[0]).toMatchObject({ type: 'web_search_result', url: 'https://example.com/news/1', title: 'Release notes', page_age: null });
      expect(typeof result.content[0].encrypted_content).toBe('string');
      expect(text.text).toBe('Version 9 shipped on Monday.');
      expect(body.stop_reason).toBe('end_turn');
      expect(body.usage).toEqual({ input_tokens: 30, output_tokens: 8, server_tool_use: { web_search_requests: 1 } });

      // The model saw a function tool, then the results as a tool message.
      expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(['web_search']);
      expect(bodies[0].tools[0].function.parameters.required).toEqual(['query']);
      const toolMsg = bodies[1].messages.find((m: any) => m.role === 'tool');
      expect(toolMsg.content).toContain('https://example.com/news/1');
      expect(toolMsg.content).toContain('Version 9 shipped on Monday.');
    });

    it('streams the same blocks as SSE with web_search_requests in message_delta', async () => {
      addSearchKey();
      mockGroq([searchCall('version 9 release'), answer('Done.')]);
      const { status, text } = await post('/v1/messages', request({ stream: true }), anthropicHeaders());

      expect(status).toBe(200);
      const events = sseEvents(text).filter(e => e.event !== 'ping');
      expect(events[0].event).toBe('message_start');
      const starts = events.filter(e => e.event === 'content_block_start').map(e => e.data.content_block.type);
      expect(starts).toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
      const jsonDelta = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta');
      expect(JSON.parse(jsonDelta!.data.delta.partial_json)).toEqual({ query: 'version 9 release' });
      const resultStart = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'web_search_tool_result');
      expect(resultStart!.data.content_block.content[0].url).toBe('https://example.com/news/1');
      const delta = events.find(e => e.event === 'message_delta');
      expect(delta!.data.delta.stop_reason).toBe('end_turn');
      expect(delta!.data.usage.server_tool_use).toEqual({ web_search_requests: 1 });
      expect(events.at(-1)!.event).toBe('message_stop');
    });

    it('honours max_uses with a max_uses_exceeded error result', async () => {
      addSearchKey();
      mockGroq([searchCall('first'), searchCall('second', 'call_s2'), answer('ok')]);
      const { body } = await post('/v1/messages', request({ tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }] }), anthropicHeaders());

      expect(runSearchMock).toHaveBeenCalledTimes(1);
      const results = body.content.filter((b: any) => b.type === 'web_search_tool_result');
      expect(results).toHaveLength(2);
      expect(results[1].content).toEqual({ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' });
      expect(body.usage.server_tool_use.web_search_requests).toBe(1);
    });

    it('applies allowed_domains and blocked_domains to the hits', async () => {
      addSearchKey();
      mockGroq([searchCall('news'), answer('ok')]);
      const { body } = await post('/v1/messages', request({ tools: [{ type: 'web_search_20250305', name: 'web_search', blocked_domains: ['blocked.test'] }] }), anthropicHeaders());
      const result = body.content.find((b: any) => b.type === 'web_search_tool_result');
      expect(result.content.map((r: any) => r.url)).toEqual(['https://example.com/news/1']);
      expect(filterHitsByDomain(HITS, { allowedDomains: ['blocked.test'] }).map(h => h.url)).toEqual(['https://blocked.test/post']);
      expect(filterHitsByDomain(HITS, { allowedDomains: ['example.com/news'] })).toHaveLength(1);
    });

    it('defers the search when the model also calls a client tool', async () => {
      addSearchKey();
      const mixed = searchCall('q');
      mixed.choices[0].message.tool_calls.push({ id: 'call_w', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } });
      mockGroq([mixed]);
      const tools = [
        { type: 'web_search_20250305', name: 'web_search' },
        { name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
      ];
      const { body } = await post('/v1/messages', request({ tools }), anthropicHeaders());
      expect(runSearchMock).not.toHaveBeenCalled();
      expect(body.content.map((b: any) => b.type)).toEqual(['tool_use']);
      expect(body.content[0].name).toBe('get_weather');
      expect(body.stop_reason).toBe('tool_use');
    });

    it('turns replayed search blocks into text the routed model can read', async () => {
      addSearchKey();
      const bodies = mockGroq([answer('Following up.')]);
      const hit = { title: 'Release notes', url: 'https://example.com/news/1', content: 'Version 9 shipped on Monday.', score: 1 };
      await post('/v1/messages', request({
        messages: [
          { role: 'user', content: 'What shipped?' },
          { role: 'assistant', content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'version 9' } },
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: hit.url, title: hit.title, encrypted_content: encodeHitContent(hit), page_age: null }] },
            { type: 'text', text: 'Version 9 shipped.' },
          ] },
          { role: 'user', content: 'And when?' },
        ],
      }), anthropicHeaders());
      const assistant = bodies[0].messages.find((m: any) => m.role === 'assistant');
      expect(assistant.content).toContain('[Searched the web for: version 9]');
      expect(assistant.content).toContain('https://example.com/news/1');
      expect(assistant.content).toContain('Version 9 shipped on Monday.');
    });

    it('keeps the old behaviour when no search key is configured', async () => {
      const bodies = mockGroq([answer('No search here.')]);
      const { status, body } = await post('/v1/messages', request(), anthropicHeaders());
      expect(status).toBe(200);
      expect(runSearchMock).not.toHaveBeenCalled();
      expect(body.content).toEqual([{ type: 'text', text: 'No search here.' }]);
      expect(body.usage.server_tool_use).toBeUndefined();
      // The server tool still reaches the model as an (empty-schema) function, as before.
      expect(bodies[0].tools[0].function.parameters).toEqual({ type: 'object', properties: {} });
    });

    it('passes a first-turn error through with its real status', async () => {
      addSearchKey();
      const { status, body } = await post('/v1/messages', request(), { 'x-api-key': 'wrong' });
      expect(status).toBe(401);
      expect(body.type).toBe('error');
      expect(runSearchMock).not.toHaveBeenCalled();
    });
  });

  describe('Responses web_search tool', () => {
    const request = (extra: Record<string, unknown> = {}) => ({
      model: 'auto',
      input: 'What shipped this week?',
      tools: [{ type: 'web_search' }],
      ...extra,
    });

    it('runs the search and reports a web_search_call item before the answer', async () => {
      addSearchKey();
      const bodies = mockGroq([searchCall('version 9 release'), answer('Version 9 shipped on Monday.')]);
      const { status, body } = await post('/v1/responses', request(), bearer());

      expect(status).toBe(200);
      expect(runSearchMock).toHaveBeenCalledTimes(1);
      expect(body.object).toBe('response');
      expect(body.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
      expect(body.output[0]).toMatchObject({
        type: 'web_search_call', status: 'completed',
        action: { type: 'search', query: 'version 9 release', sources: [{ type: 'url', url: 'https://example.com/news/1' }, { type: 'url', url: 'https://blocked.test/post' }] },
      });
      expect(body.output[0].id).toMatch(/^ws_/);
      expect(body.output_text).toBe('Version 9 shipped on Monday.');
      expect(body.usage.input_tokens).toBe(30);
      expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual(['web_search']);
      expect(bodies[1].messages.find((m: any) => m.role === 'tool').content).toContain('Version 9 shipped on Monday.');
    });

    it('streams web_search_call events and a completed response', async () => {
      addSearchKey();
      mockGroq([searchCall('version 9 release'), answer('Done.')]);
      const { status, text } = await post('/v1/responses', request({ stream: true }), bearer());

      expect(status).toBe(200);
      const events = sseEvents(text);
      const names = events.map(e => e.event);
      expect(names[0]).toBe('response.created');
      expect(names).toContain('response.web_search_call.searching');
      expect(names).toContain('response.web_search_call.completed');
      const completed = events.find(e => e.event === 'response.completed')!.data.response;
      expect(completed.output.map((i: any) => i.type)).toEqual(['web_search_call', 'message']);
      expect(completed.id).toBe(events[0].data.response.id);
      const seq = events.map(e => e.data.sequence_number);
      expect(seq).toEqual([...seq].sort((a, b) => a - b));
    });

    it('keeps a final answer cut off at the token limit incomplete', async () => {
      addSearchKey();
      const cut = answer('Version 9 shi');
      cut.choices[0].finish_reason = 'length';
      mockGroq([searchCall('version 9 release'), cut]);
      const { text } = await post('/v1/responses', request({ stream: true }), bearer());

      const names = sseEvents(text).map(e => e.event);
      expect(names).not.toContain('response.completed');
      const final = sseEvents(text).find(e => e.event === 'response.incomplete')!.data.response;
      expect(final).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    });

    it('drops the tool as before when no search key is configured', async () => {
      const bodies = mockGroq([answer('Plain answer.')]);
      const { status, body } = await post('/v1/responses', request(), bearer());
      expect(status).toBe(200);
      expect(runSearchMock).not.toHaveBeenCalled();
      expect(body.output.map((i: any) => i.type)).toEqual(['message']);
      expect(bodies[0].tools).toBeUndefined();
    });

    it('turns a replayed web_search_call into a note on the next assistant turn', async () => {
      const bodies = mockGroq([answer('ok')]);
      await post('/v1/responses', {
        model: 'auto',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What shipped?' }] },
          { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'version 9', sources: [{ type: 'url', url: 'https://example.com/news/1' }] } },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Version 9 shipped.' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'When?' }] },
        ],
      }, bearer());
      const assistants = bodies[0].messages.filter((m: any) => m.role === 'assistant');
      expect(assistants).toHaveLength(1);
      expect(assistants[0].content).toContain('[Searched the web for: version 9. Sources: https://example.com/news/1]');
      expect(assistants[0].content).toContain('Version 9 shipped.');
    });
  });

  describe('MCP web_search tool', () => {
    async function rpc(message: unknown) {
      return post('/mcp', message, bearer());
    }

    it('searches through runSearch and returns the hits', async () => {
      const { status, body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: 'version 9', max_results: 3, topic: 'news' } } });
      expect(status).toBe(200);
      expect(runSearchMock).toHaveBeenCalledWith('version 9', { maxResults: 3, topic: 'news' });
      const data = JSON.parse(body.result.content[0].text);
      expect(data.provider).toBe('tavily');
      expect(data.results[0]).toEqual({ title: 'Release notes', url: 'https://example.com/news/1', content: 'Version 9 shipped on Monday.' });
    });

    it('reports a missing query as a tool error', async () => {
      const { body } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'web_search', arguments: {} } });
      expect(body.result.isError).toBe(true);
    });
  });
});
