import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';

// Route-level characterization tests for the fallback hardening pack:
//   item 3 — a daily-allocation 429 (Cloudflare "used up your daily free
//            allocation") benches until the next UTC midnight, not 90s;
//   item 4 — an empty completion with finish_reason 'length' (reasoning model
//            spent the whole output budget on hidden reasoning) fails over
//            WITHOUT a cooldown or model penalty;
//   item 5 — the wall-clock retry budget stops new attempts and returns the
//            rich exhaustion error;
//   item 6 — a provider response without a `usage` block no longer logs 0
//            tokens (chars/4 estimation, matching the streaming path).

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
const { setRoutingStrategy, getAllPenalties } = await import('../../services/router.js');
const { msUntilNextUtcMidnight } = await import('../../lib/fallback-loop.js');

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
  try { json = JSON.parse(raw); } catch { /* SSE */ }
  return { status: res.status, body: json, raw, headers: res.headers };
}

const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'a real answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
};
// Provider omits `usage` entirely (several free tiers do on some endpoints).
const NO_USAGE_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'an answer without a usage block' }, finish_reason: 'stop' }],
};
const emptyWithFinish = (finish: string) => ({
  choices: [{ message: { role: 'assistant', content: '' }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
});

function firstCalledModelDbId(): number {
  const modelId = chatCompletion.mock.calls[0][2] as string;
  const row = getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = ?").get(modelId) as { id: number };
  return row.id;
}

function cooldownRowFor(modelId: string) {
  return getDb().prepare(
    "SELECT expires_at_ms FROM rate_limit_cooldowns WHERE platform = 'groq' AND model_id = ?",
  ).get(modelId) as { expires_at_ms: number } | undefined;
}

describe('fallback hardening (items 3, 4, 5, 6)', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');
    const { encrypted, iv, authTag } = encrypt('hardening-test-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'hardening', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare('DELETE FROM requests').run();
  });

  afterEach(() => {
    delete process.env.FALLBACK_TIME_BUDGET_MS;
  });

  it('item 3: a daily-allocation 429 benches until the next UTC midnight, not 90s', async () => {
    chatCompletion
      .mockRejectedValueOnce(Object.assign(
        new Error('Cloudflare API error 429: you have used up your daily free allocation of 10,000 neurons'),
        { status: 429 },
      ))
      .mockResolvedValueOnce(GOOD_RESULT);

    const before = Date.now();
    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'daily allocation bench test' }],
    }, key);

    expect(status).toBe(200); // failed over
    const firstModel = chatCompletion.mock.calls[0][2] as string;
    const row = cooldownRowFor(firstModel);
    expect(row).toBeDefined();
    // Benched to (roughly) the next UTC midnight, far beyond the 90s transient.
    const expected = before + msUntilNextUtcMidnight(before);
    expect(Math.abs(row!.expires_at_ms - expected)).toBeLessThan(10_000);
  });

  it('item 4: empty completion with finish_reason length fails over without cooldown or penalty', async () => {
    chatCompletion
      .mockResolvedValueOnce(emptyWithFinish('length')) // hidden-reasoning truncation
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'reasoning truncation policy test' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('a real answer');
    expect(chatCompletion).toHaveBeenCalledTimes(2); // still failed over
    const firstModel = chatCompletion.mock.calls[0][2] as string;
    // The truncated turn is NOT a provider-health signal: no bench, no penalty.
    expect(cooldownRowFor(firstModel)).toBeUndefined();
    expect(getAllPenalties().some(p => p.modelDbId === firstCalledModelDbId())).toBe(false);
  });

  it('item 4 control: an empty completion with finish_reason stop still benches as before', async () => {
    chatCompletion
      .mockResolvedValueOnce(emptyWithFinish('stop'))
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'empty stop control test' }],
    }, key);

    expect(status).toBe(200);
    const firstModel = chatCompletion.mock.calls[0][2] as string;
    expect(cooldownRowFor(firstModel)).toBeDefined(); // genuine dead turn: benched
  });

  it('item 4 (stream): a zero-text stream ending in finish_reason length skips the bench', async () => {
    async function* lengthTruncatedStream() {
      yield { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
      yield { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] };
    }
    async function* goodStream() {
      yield { id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'streamed answer' }, finish_reason: null }] };
      yield { id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    }
    streamChatCompletion
      .mockReturnValueOnce(lengthTruncatedStream())
      .mockReturnValueOnce(goodStream());

    const { status, raw } = await post(app, '/v1/chat/completions', {
      stream: true, messages: [{ role: 'user', content: 'stream truncation policy test' }],
    }, key);

    expect(status).toBe(200);
    expect(raw).toContain('streamed answer');
    expect(streamChatCompletion).toHaveBeenCalledTimes(2);
    const firstModel = streamChatCompletion.mock.calls[0][2] as string;
    expect(cooldownRowFor(firstModel)).toBeUndefined();
  });

  it('item 5: the wall-clock budget stops retries and returns the rich exhaustion error', async () => {
    process.env.FALLBACK_TIME_BUDGET_MS = '1';
    chatCompletion.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 15)); // ensure the budget is spent after attempt 0
      throw Object.assign(new Error('Groq API error 429: rate limit'), { status: 429 });
    });

    const { status, body, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'time budget test' }],
    }, key);

    expect(status).toBe(429);
    expect(chatCompletion).toHaveBeenCalledTimes(1); // the first attempt always runs; no second start
    expect(body.error.message).toContain('retry time budget');
    expect(body.error.message).toContain('Attempt trail:');
    expect(headers.get('x-fallback-attempts')).toBe('1');
  });

  it('item 6: /v1/chat/completions logs estimated tokens when the provider omits usage', async () => {
    chatCompletion.mockResolvedValueOnce(NO_USAGE_RESULT);

    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'usage fallback test with a reasonably long prompt' }],
    }, key);

    expect(status).toBe(200);
    const row = getDb().prepare("SELECT input_tokens, output_tokens FROM requests WHERE status = 'success' ORDER BY id DESC LIMIT 1")
      .get() as { input_tokens: number; output_tokens: number };
    expect(row.input_tokens).toBeGreaterThan(0);   // was 0 pre-fix
    expect(row.output_tokens).toBeGreaterThan(0);  // was 0 pre-fix
    // The rate-limit token ledger is fed too (was recordTokens(…, 0)).
    const usage = getDb().prepare("SELECT COALESCE(SUM(tokens), 0) AS t FROM rate_limit_usage WHERE kind = 'tokens'").get() as { t: number };
    expect(usage.t).toBeGreaterThan(0);
  });

  it('item 6: legacy /v1/completions logs estimated tokens when usage is missing', async () => {
    chatCompletion.mockResolvedValueOnce(NO_USAGE_RESULT);

    const { status } = await post(app, '/v1/completions', {
      prompt: 'legacy usage fallback test prompt',
    }, key);

    expect(status).toBe(200);
    const row = getDb().prepare("SELECT input_tokens, output_tokens FROM requests WHERE status = 'success' ORDER BY id DESC LIMIT 1")
      .get() as { input_tokens: number; output_tokens: number };
    expect(row.input_tokens).toBeGreaterThan(0);
    expect(row.output_tokens).toBeGreaterThan(0);
  });

  it('item 6: /v1/responses feeds the rate-limit token ledger when usage is missing', async () => {
    chatCompletion.mockResolvedValueOnce(NO_USAGE_RESULT);

    const { status } = await post(app, '/v1/responses', {
      input: 'responses usage fallback test',
    }, key);

    expect(status).toBe(200);
    const usage = getDb().prepare("SELECT COALESCE(SUM(tokens), 0) AS t FROM rate_limit_usage WHERE kind = 'tokens'").get() as { t: number };
    expect(usage.t).toBeGreaterThan(0); // was recordTokens(…, usage?.total_tokens ?? 0)
  });
});
