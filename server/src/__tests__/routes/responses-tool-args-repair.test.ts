import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Same scripted-provider mock pattern as proxy-empty-completion.test.ts.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy } = await import('../../services/router.js');

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw };
}

// The exact production failure: GLM emitted update_plan's `plan` array as a
// JSON-encoded STRING; Codex rejected it ("invalid type: string, expected a
// sequence") and the agent turn died at its status-update call.
const BROKEN_ARGS = JSON.stringify({
  explanation: 'plan update',
  plan: '[{"step": "Review design", "status": "in_progress"}]',
});

const UPDATE_PLAN_TOOL = {
  type: 'function',
  name: 'update_plan',
  parameters: {
    type: 'object',
    properties: { explanation: { type: 'string' }, plan: { type: 'array' } },
  },
};

async function* brokenToolCallStream() {
  yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'update_plan', arguments: BROKEN_ARGS } }] } }] };
}

describe('Tool-argument repair on /v1/responses (double-encoded nested JSON)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  it('stream: repairs the arguments in function_call_arguments.done and the final response', async () => {
    streamChatCompletion.mockReturnValueOnce(brokenToolCallStream());

    const { status, raw } = await post(app, '/v1/responses', {
      input: 'update the plan',
      stream: true,
      tools: [UPDATE_PLAN_TOOL],
    }, key);

    expect(status).toBe(200);
    const doneLine = raw.split('\n').find((l) => l.startsWith('data:') && l.includes('response.function_call_arguments.done'));
    expect(doneLine).toBeDefined();
    const done = JSON.parse(doneLine!.slice('data: '.length));
    const repaired = JSON.parse(done.arguments);
    expect(Array.isArray(repaired.plan)).toBe(true);
    expect(repaired.plan[0].step).toBe('Review design');
  });

  it('non-stream: repairs the arguments in the function_call output item', async () => {
    chatCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'update_plan', arguments: BROKEN_ARGS } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });

    const { status, body } = await post(app, '/v1/responses', {
      input: 'update the plan',
      tools: [UPDATE_PLAN_TOOL],
    }, key);

    expect(status).toBe(200);
    const fc = body.output.find((o: any) => o.type === 'function_call');
    expect(fc).toBeDefined();
    const repaired = JSON.parse(fc.arguments);
    expect(Array.isArray(repaired.plan)).toBe(true);
  });

  it('non-stream /v1/chat/completions: repairs tool_calls in the message', async () => {
    chatCompletion.mockResolvedValueOnce({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'update_plan', arguments: BROKEN_ARGS } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'update the plan' }],
      tools: [{ type: 'function', function: { name: 'update_plan', parameters: UPDATE_PLAN_TOOL.parameters } }],
    }, key);

    expect(status).toBe(200);
    const repaired = JSON.parse(body.choices[0].message.tool_calls[0].function.arguments);
    expect(Array.isArray(repaired.plan)).toBe(true);
  });
});
