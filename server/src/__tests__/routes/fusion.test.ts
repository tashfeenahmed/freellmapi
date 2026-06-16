import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { isFusionModel, fusionConfigSchema } from '../../services/fusion.js';
import { getOrderedFusionChain, setRoutingStrategy, getRoutingStrategy } from '../../services/router.js';
import { setCooldown } from '../../services/ratelimit.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (SSE) */ }
  return { status: res.status, body: json, text };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

// Build a fetch mock that returns a fixed answer for a given upstream host, or
// a 429 for hosts listed in `rateLimited`. Lets each test stage which panel
// members succeed/fail purely by URL.
// A minimal OpenAI-wire SSE body for the streaming judge path.
function sseBody(content: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); } });
}

function mockUpstreams(answers: Record<string, string>, rateLimited: Set<string> = new Set(), streamAnswers: Record<string, string> = {}) {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const host of rateLimited) {
      if (u.includes(host)) {
        return { ok: false, status: 429, headers: new Headers(), text: () => Promise.resolve('rate limited') } as any;
      }
    }
    // Streaming (judge) hosts return an SSE body consumed by streamChatCompletion.
    for (const [host, content] of Object.entries(streamAnswers)) {
      if (u.includes(host)) {
        return { ok: true, status: 200, headers: new Headers(), body: sseBody(content) } as any;
      }
    }
    for (const [host, content] of Object.entries(answers)) {
      if (u.includes(host)) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
          }),
        } as any;
      }
    }
    return origFetch(url as any, init as any);
  });
}

describe('isFusionModel', () => {
  it('matches the virtual fusion id and its suffix form, nothing else', () => {
    expect(isFusionModel('fusion')).toBe(true);
    expect(isFusionModel('FUSION')).toBe(true);
    expect(isFusionModel('fusion:smart')).toBe(true);
    expect(isFusionModel('auto')).toBe(false);
    expect(isFusionModel('gpt-oss-120b')).toBe(false);
    expect(isFusionModel(undefined)).toBe(false);
  });
});

describe('fusionConfigSchema', () => {
  it('accepts an empty object and a fully specified config', () => {
    expect(fusionConfigSchema.safeParse({}).success).toBe(true);
    const full = fusionConfigSchema.safeParse({ models: ['a', 'b'], k: 4, judge: 'j', strategy: 'synthesize', expose_panel: true });
    expect(full.success).toBe(true);
  });
  it('rejects a non-positive k and an unknown strategy', () => {
    expect(fusionConfigSchema.safeParse({ k: 0 }).success).toBe(false);
    expect(fusionConfigSchema.safeParse({ strategy: 'vote' }).success).toBe(false);
  });
});

describe('fusion route (/v1/chat/completions, model: "fusion")', () => {
  let app: Express;
  let groqModel: string;
  let cerebrasModel: string;
  let openrouterModel: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    const db = getDb();
    const pick = (platform: string) => (db.prepare(
      'SELECT m.model_id FROM models m WHERE m.platform = ? AND m.enabled = 1 ORDER BY m.intelligence_rank LIMIT 1',
    ).get(platform) as { model_id: string }).model_id;
    groqModel = pick('groq');
    cerebrasModel = pick('cerebras');
    openrouterModel = pick('openrouter');
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare("DELETE FROM settings WHERE key = 'fusion_config'").run();
    for (const platform of ['groq', 'cerebras', 'openrouter']) {
      const r = await request(app, 'POST', '/api/keys', { platform, key: `k_${platform}_fusion`, label: 'fusion-test' });
      expect(r.status).toBe(201);
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('synthesizes one answer when ≥2 panel members succeed (judge runs)', async () => {
    mockUpstreams({
      'api.groq.com': 'groq says alpha',
      'api.cerebras.ai': 'cerebras says beta',
      'openrouter.ai': 'JUDGE FINAL ANSWER',
    });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      messages: [{ role: 'user', content: 'q' }],
      fusion: { models: [groqModel, cerebrasModel], judge: openrouterModel, expose_panel: true },
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.model).toBe('fusion');
    expect(body.choices[0].message.content).toBe('JUDGE FINAL ANSWER');
    expect(body.x_fusion.synthesized).toBe(true);
    expect(body.x_fusion.judge).toContain('openrouter');
    expect(body.x_fusion.panel.filter((p: any) => p.status === 'ok')).toHaveLength(2);
    // Honest usage: two panel calls + judge, 12 tokens each.
    expect(body.usage.total_tokens).toBe(36);
    // Always-on routing summary: the panel models that replied + the judge.
    expect(body._fusion.panel.map((p: any) => p.model).sort()).toEqual([groqModel, cerebrasModel].sort());
    expect(body._fusion.panel.every((p: any) => typeof p.platform === 'string')).toBe(true);
    expect(body._fusion.judge).toEqual({ platform: 'openrouter', model: openrouterModel });
    expect(body._fusion.synthesized).toBe(true);
  });

  it('returns the lone survivor directly (no judge) when only one panel member succeeds', async () => {
    mockUpstreams(
      { 'api.groq.com': 'only groq survived' },
      new Set(['api.cerebras.ai']),
    );
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      messages: [{ role: 'user', content: 'q' }],
      fusion: { models: [groqModel, cerebrasModel], expose_panel: true },
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('only groq survived');
    expect(body.x_fusion.synthesized).toBe(false);
    expect(body.x_fusion.panel.find((p: any) => p.status === 'failed')).toBeTruthy();
    // Routing summary present even without a judge: one survivor, judge null.
    expect(body._fusion.panel).toEqual([{ platform: 'groq', model: groqModel }]);
    expect(body._fusion.judge).toBeNull();
  });

  it('best_of strategy skips the judge even with a full panel', async () => {
    mockUpstreams({
      'api.groq.com': 'short',
      'api.cerebras.ai': 'a noticeably longer answer that best_of should prefer',
      'openrouter.ai': 'JUDGE SHOULD NOT RUN',
    });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      messages: [{ role: 'user', content: 'q' }],
      fusion: { models: [groqModel, cerebrasModel], judge: openrouterModel, strategy: 'best_of', expose_panel: true },
    }, authHeaders());

    expect(status).toBe(200);
    expect(body.x_fusion.synthesized).toBe(false);
    expect(body.choices[0].message.content).toContain('longer answer'); // longest, not the judge
  });

  it('returns 429 when the entire panel fails', async () => {
    mockUpstreams({}, new Set(['api.groq.com', 'api.cerebras.ai']));
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      messages: [{ role: 'user', content: 'q' }],
      fusion: { models: [groqModel, cerebrasModel] },
    }, authHeaders());
    expect(status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
  });

  it('drops unknown models from an explicit panel and reports them', async () => {
    mockUpstreams({ 'api.groq.com': 'groq answer' });
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      messages: [{ role: 'user', content: 'q' }],
      fusion: { models: [groqModel, 'no-such-model'], expose_panel: true },
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.x_fusion.dropped.some((d: string) => d.includes('no-such-model'))).toBe(true);
  });

  it('rejects tool-bearing fusion requests with 422', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
    }, authHeaders());
    expect(status).toBe(422);
    expect(body.error.code).toBe('fusion_no_tools');
  });

  it('tags every panel/judge sub-call with requested_model="fusion"', async () => {
    mockUpstreams({
      'api.groq.com': 'a', 'api.cerebras.ai': 'b', 'openrouter.ai': 'judged',
    });
    await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      messages: [{ role: 'user', content: 'q' }],
      fusion: { models: [groqModel, cerebrasModel], judge: openrouterModel },
    }, authHeaders());
    const rows = getDb().prepare("SELECT requested_model, status FROM requests").all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(3); // 2 panel + judge
    expect(rows.every(r => r.requested_model === 'fusion')).toBe(true);
  });

  it('GET /api/settings/fusion returns defaults; PUT round-trips, clamps k, dedupes models', async () => {
    const def = await request(app, 'GET', '/api/settings/fusion', undefined);
    expect(def.status).toBe(200);
    expect(def.body.config.mode).toBe('auto');
    expect(def.body.maxK).toBeGreaterThan(0);

    const put = await request(app, 'PUT', '/api/settings/fusion', {
      mode: 'explicit',
      models: [groqModel, groqModel, cerebrasModel], // dup groq
      judge: openrouterModel,
      k: 999, // over the cap
      strategy: 'synthesize',
      expose_panel: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.config.models).toEqual([groqModel, cerebrasModel]); // deduped
    expect(put.body.config.k).toBe(put.body.maxK); // clamped

    const get = await request(app, 'GET', '/api/settings/fusion', undefined);
    expect(get.body.config.mode).toBe('explicit');
    expect(get.body.config.judge).toBe(openrouterModel);
  });

  it('uses the saved explicit panel when a request omits fusion.models', async () => {
    await request(app, 'PUT', '/api/settings/fusion', {
      mode: 'explicit', models: [groqModel, cerebrasModel], judge: openrouterModel,
      k: 4, strategy: 'synthesize', expose_panel: true,
    });
    mockUpstreams({ 'api.groq.com': 'a', 'api.cerebras.ai': 'b', 'openrouter.ai': 'SAVED PANEL JUDGE' });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion', messages: [{ role: 'user', content: 'q' }],
    }, authHeaders());
    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('SAVED PANEL JUDGE');
    expect(body.x_fusion.panel_requested.sort()).toEqual([groqModel, cerebrasModel].sort());
  });

  it('a per-request fusion.models overrides the saved explicit panel', async () => {
    await request(app, 'PUT', '/api/settings/fusion', {
      mode: 'explicit', models: [cerebrasModel], judge: openrouterModel,
      k: 4, strategy: 'synthesize', expose_panel: true,
    });
    mockUpstreams({ 'api.groq.com': 'only groq', 'api.cerebras.ai': 'b' });

    const { body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion', messages: [{ role: 'user', content: 'q' }],
      fusion: { models: [groqModel] }, // overrides the saved [cerebras]
    }, authHeaders());
    expect(body.x_fusion.panel_requested).toEqual([groqModel]);
  });

  it('auto-panel ordering follows the picked routing strategy, deterministically', () => {
    const original = getRoutingStrategy();
    try {
      // Priority mode: ordering is the manual chain order, and stable.
      setRoutingStrategy('priority');
      const p1 = getOrderedFusionChain().map(c => c.modelId);
      const p2 = getOrderedFusionChain().map(c => c.modelId);
      expect(p1.length).toBeGreaterThan(0);
      expect(p2).toEqual(p1);

      // Bandit mode: previously Thompson-sampled (random per call); now the
      // deterministic expected-score ranking, so two calls must be identical.
      setRoutingStrategy('smartest');
      const s1 = getOrderedFusionChain().map(c => c.modelId);
      const s2 = getOrderedFusionChain().map(c => c.modelId);
      expect(s2).toEqual(s1);

      // The strategy actually drives the ordering: 'smartest' (intelligence)
      // and 'priority' (manual chain order) rank the seeded catalog differently.
      expect(s1).not.toEqual(p1);
    } finally {
      setRoutingStrategy(original);
    }
  });

  it('auto-panel excludes models whose platform has no usable key', async () => {
    const db = getDb();
    // Strip every key, then configure ONLY groq — no cerebras/openrouter/etc.
    db.prepare('DELETE FROM api_keys').run();
    const r = await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'k_groq_only', label: 'only-groq' });
    expect(r.status).toBe(201);

    const candidates = getOrderedFusionChain();
    expect(candidates.length).toBeGreaterThan(0);
    // Even though the seeded catalog has many higher-ranked models on other
    // platforms (cerebras, openrouter, opencode…), none are routable without a
    // key — so the panel pool is groq-only.
    expect(candidates.every(c => c.platform === 'groq')).toBe(true);
  });

  it('auto-panel excludes a model whose only key is on cooldown', async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    await request(app, 'POST', '/api/keys', { platform: 'groq', key: 'k_groq_cool', label: 'cool' });
    const keyId = (db.prepare("SELECT id FROM api_keys WHERE platform = 'groq'").get() as { id: number }).id;

    const before = getOrderedFusionChain().filter(c => c.platform === 'groq');
    expect(before.length).toBeGreaterThan(0);
    const target = before[0]; // the top groq model under the strategy

    // Bench that exact model+key (as a 402/429 cooldown would), then re-check.
    setCooldown('groq', target.modelId, keyId, 60_000);
    const after = getOrderedFusionChain();
    expect(after.find(c => c.modelId === target.modelId)).toBeUndefined();
  });

  it('auto-panel refills failed slots from the fallback chain', async () => {
    // groq is entirely rate-limited; cerebras + openrouter answer. The two groq
    // panel slots fail, and the panel refills from the next chain models.
    mockUpstreams(
      { 'api.cerebras.ai': 'cerebras answer', 'openrouter.ai': 'openrouter answer' },
      new Set(['api.groq.com']),
    );
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      messages: [{ role: 'user', content: 'q' }],
      fusion: { k: 3, judge: cerebrasModel, expose_panel: true },
    }, authHeaders());
    expect(status).toBe(200);

    const attempts = body.x_fusion.panel;
    // More models were tried than the initial 3-model panel → a slot refilled.
    expect(attempts.length).toBeGreaterThan(3);
    const ok = attempts.filter((p: any) => p.status === 'ok');
    expect(ok.length).toBeGreaterThanOrEqual(2);
    // The survivors came from the chain refill, not groq (which was down).
    expect(ok.every((p: any) => p.platform !== 'groq')).toBe(true);
    expect(attempts.some((p: any) => p.platform === 'groq' && p.status === 'failed')).toBe(true);
  });

  it('streams panel + judge trace frames then the final answer when stream:true', async () => {
    // Panel models answer via chatCompletion (JSON); the judge streams (SSE).
    mockUpstreams(
      { 'api.groq.com': 'panel answer A', 'api.cerebras.ai': 'panel answer B' },
      new Set(),
      { 'openrouter.ai': 'STREAMED SYNTHESIS' },
    );
    const { status, text } = await request(app, 'POST', '/v1/chat/completions', {
      model: 'fusion',
      stream: true,
      messages: [{ role: 'user', content: 'q' }],
      fusion: { models: [groqModel, cerebrasModel], judge: openrouterModel },
    }, authHeaders());
    expect(status).toBe(200);

    // Parse the SSE frames.
    const frames = text.split('\n')
      .filter(l => l.startsWith('data: ') && l.slice(6).trim() !== '[DONE]')
      .map(l => JSON.parse(l.slice(6)));

    // Additive _fusion frames: one panel frame per member, plus a judge frame.
    const panelFrames = frames.filter(f => f._fusion?.event === 'panel');
    expect(panelFrames).toHaveLength(2);
    expect(panelFrames.map(f => f._fusion.model).sort()).toEqual([groqModel, cerebrasModel].sort());
    expect(panelFrames.every(f => f._fusion.status === 'ok' && typeof f._fusion.content === 'string')).toBe(true);
    const judgeFrame = frames.find(f => f._fusion?.event === 'judge');
    expect(judgeFrame._fusion).toMatchObject({ platform: 'openrouter', model: openrouterModel });

    // The final answer still streams as standard content deltas + terminal stop.
    expect(text).toContain('STREAMED SYNTHESIS');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // _fusion panel frames precede the final content frame.
    expect(text.indexOf('"event":"panel"')).toBeLessThan(text.indexOf('STREAMED SYNTHESIS'));
  });
});
