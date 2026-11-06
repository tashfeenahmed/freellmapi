import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns, isOnCooldown } from '../../services/ratelimit.js';
import {
  runDecision,
  DecisionError,
  listDecisionModels,
  setDecisionModelEnabled,
  decisionsAvailable,
  DECISION_PLATFORMS,
} from '../../services/decision.js';
import { listAllMediaModels } from '../../services/media.js';
import { seedDecisionModels } from '../helpers/decision-models.js';

const realFetch = globalThis.fetch;

function addKey(platform: string, raw = `${platform}-test-key`): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
  return Number(row.lastInsertRowid);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Call = [string, RequestInit];
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(String(url), init)));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const calls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls as unknown as Call[];
const bodyOf = (call: Call) => JSON.parse(call[1].body as string);

const REQUEST = {
  state: 'Write a Python function that merges two sorted lists.',
  questions: {
    tier: { type: 'choice' as const, instructions: 'Which tier should answer?', criteria: { light: 'chat', code: 'coding' } },
  },
};
const ANSWERS = { tier: { type: 'choice', choice: 'code', probabilities: { light: 0.02, code: 0.98 }, confidence: 0.96 } };

function logRows() {
  return getDb().prepare('SELECT model_id, platform, status, question_count, input_tokens FROM decision_requests ORDER BY id').all() as
    Array<{ model_id: string; platform: string; status: string; question_count: number; input_tokens: number }>;
}

describe('decision service', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedDecisionModels();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('has adapters for the supported decision platforms', () => {
    expect([...DECISION_PLATFORMS].sort()).toEqual(['aisense', 'apinex', 'beatapi', 'blockrun', 'cloudflare', 'halx', 'openrouter']);
  });

  function seed(platform: string, model: string) {
    getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES (?,?,?,'decision',20,1,'free')").run(platform, model, model);
  }

  it('maps HAL-X questions and never transmits a saved credential', async () => {
    seed('halx', 'THX-01'); addKey('halx', 'no-key');
    const fn = mockFetch(() => json({ model: 'THX-01', answers: ANSWERS, usage: { input_tokens: 35, output_tokens: 0 } }));
    expect((await runDecision(REQUEST, { model: 'THX-01' })).provider).toBe('halx');
    expect(calls(fn)[0][0]).toBe('https://api.hal-x.ai/v1/systemone');
    expect(calls(fn)[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(calls(fn)[0][1].redirect).toBe('error');
    expect(bodyOf(calls(fn)[0]).questions.tier).toEqual({ type: 'choice', question: REQUEST.questions.tier.instructions, criteria: REQUEST.questions.tier.criteria });
    expect(decisionsAvailable()).toBe(true);
  });

  it.each(['clef', 'nimble', 'tev1'])('selects AI SENSE %s rather than its default rules engine', async model => {
    seed('aisense', model); addKey('aisense', 'no-key');
    const fn = mockFetch(() => json({ model, model_version: model + ':latest', answers: ANSWERS, usage: { input_tokens: 42 } }));
    const result = await runDecision(REQUEST, { model });
    expect(result.modelVersion).toBe(model + ':latest');
    expect(result.answers).toEqual(ANSWERS);
    expect(calls(fn)[0][0]).toBe('https://aisenseapi.com/services/v1/decide');
    expect(bodyOf(calls(fn)[0])).toEqual({ model, state: { message: REQUEST.state }, questions: REQUEST.questions });
    expect(calls(fn)[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('rejects substituted and missing keyless decision answers', async () => {
    seed('halx', 'THX-01'); addKey('halx', 'no-key');
    for (const response of [{ model: 'other', answers: ANSWERS }, { model: 'THX-01', answers: {} }, { model: 'THX-01', answers: { tier: { type: 'choice', choice: 'wrong' } } }]) {
      mockFetch(() => json(response));
      await expect(runDecision(REQUEST, { model: 'THX-01' })).rejects.toMatchObject({ status: 502 });
    }
  });

  it('keeps keyless-provider rate limits in the normal cooldown chain', async () => {
    seed('aisense', 'clef'); const key = addKey('aisense', 'no-key');
    mockFetch(() => json({ error: 'daily quota' }, 429, { 'retry-after': '3600' }));
    await expect(runDecision(REQUEST, { model: 'clef' })).rejects.toMatchObject({ status: 429, retryAfterMs: 3600000 });
    expect(isOnCooldown('aisense', 'clef', key)).toBe(true);
  });

  it('sends Clairic fields, preserves nullable values and excludes it from choice auto-routing', async () => {
    seed('cloudflare', '@cf/cloudflare/clairic'); addKey('cloudflare', 'acct:tok');
    const request = { state: 'Invoice INV-2291: four units at $250 plus $80 shipping.', fields: { invoice_number: { type: 'text' as const }, total: { type: 'number' as const, decimals: 2, unit: 'USD' } } };
    const answers = { invoice_number: { type: 'text', value: null, p_null: 1 }, total: { type: 'number', value: 1080 } };
    const fn = mockFetch(() => json({ success: true, result: { model: 'clairic', answers, truncated: false, usage: { input_tokens: 288 } } }));
    expect(await runDecision(request)).toMatchObject({ model: '@cf/cloudflare/clairic', answers, truncated: false, usage: { input_tokens: 288, output_tokens: 0 } });
    expect(bodyOf(calls(fn)[0])).toEqual({ model: 'clairic', ...request });
    await expect(runDecision(REQUEST, { model: '@cf/cloudflare/clairic' })).rejects.toMatchObject({ status: 400 });
    await expect(runDecision(request, { model: '@cf/cloudflare/clef-flash' })).rejects.toMatchObject({ status: 400 });
    getDb().prepare("UPDATE media_models SET enabled=0 WHERE model_id != '@cf/cloudflare/clairic'").run();
    expect(decisionsAvailable()).toBe(false);
    await expect(runDecision(REQUEST)).rejects.toMatchObject({ status: 503 });
    expect(calls(fn)).toHaveLength(1);
  });

  it('reports extraction cooldown rather than claiming no key is installed', async () => {
    seed('cloudflare', '@cf/cloudflare/clairic'); addKey('cloudflare', 'acct:tok');
    const request = { state: 'Invoice $20', fields: { total: { type: 'number' as const } } };
    mockFetch(() => json({ error: 'quota exceeded' }, 429, { 'retry-after': '60' }));
    await expect(runDecision(request)).rejects.toMatchObject({ status: 429 });
    await expect(runDecision(request)).rejects.toMatchObject({ status: 429, code: 'decision_keys_cooling_down' });
  });

  it('calls Cloudflare ai/run with the account from the key and the short model selector', async () => {
    addKey('cloudflare', 'acct123:cf-token');
    const fn = mockFetch(() => json({ success: true, result: { model: 'clef-flash', answers: ANSWERS, usage: { input_tokens: 219, output_tokens: 0 } } }));
    const out = await runDecision(REQUEST, { clientAgent: null });
    expect(out).toEqual({ model: '@cf/cloudflare/clef-flash', provider: 'cloudflare', answers: ANSWERS, usage: { input_tokens: 219, output_tokens: 0 } });
    const [url, init] = calls(fn)[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token');
    expect(bodyOf(calls(fn)[0])).toEqual({ model: 'clef-flash', state: REQUEST.state, questions: REQUEST.questions });
    expect(logRows()).toEqual([{ model_id: '@cf/cloudflare/clef-flash', platform: 'cloudflare', status: 'ok', question_count: 1, input_tokens: 219 }]);
  });

  it('calls OpenRouter alpha decisions with the full model id', async () => {
    addKey('openrouter', 'sk-or-test');
    const fn = mockFetch(() => json({ model: 'inception/mercury-decide-20260930', answers: ANSWERS, usage: { input_tokens: 156, output_tokens: 1, cost: 0 } }));
    const out = await runDecision(REQUEST, { model: 'inception/mercury-decide:free', clientAgent: null });
    expect(out.provider).toBe('openrouter');
    expect(out.answers).toEqual(ANSWERS);
    expect(calls(fn)[0][0]).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(bodyOf(calls(fn)[0]).model).toBe('inception/mercury-decide:free');
  });

  it("'auto' falls over to the next model when the first one's key is rate limited", async () => {
    const cfKey = addKey('cloudflare', 'acct:tok');
    addKey('openrouter', 'sk-or');
    const fn = mockFetch(url => url.includes('cloudflare')
      ? json({ errors: [{ message: 'rate limited' }] }, 429, { 'retry-after': '30' })
      : json({ answers: ANSWERS, usage: { input_tokens: 150, output_tokens: 1 } }));
    const out = await runDecision(REQUEST, { model: 'auto', clientAgent: null });
    expect(out.provider).toBe('openrouter');
    expect(calls(fn)).toHaveLength(2);
    expect(isOnCooldown('cloudflare', '@cf/cloudflare/clef-flash', cfKey)).toBe(true);
    expect(logRows().map(r => r.status)).toEqual(['error', 'ok']);
  });

  it('honours a back-off stated in the error body when there is no header', async () => {
    addKey('cloudflare', 'acct:tok');
    // A Gemini-shaped RetryInfo in the body with no Retry-After header: the
    // chat path (buildUpstreamError) already reads it; the decision chain must too.
    mockFetch(() => json({ error: { message: 'busy', retry_delay: '45s' } }, 429));
    const err = await runDecision(REQUEST, { model: '@cf/cloudflare/clef-flash', clientAgent: null }).catch(e => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(45_000);
  });

  it('prefers a header Retry-After over a body hint', async () => {
    addKey('cloudflare', 'acct:tok');
    mockFetch(() => json({ error: { message: 'busy', retry_delay: '45s' } }, 429, { 'retry-after': '12' }));
    const err = await runDecision(REQUEST, { model: '@cf/cloudflare/clef-flash', clientAgent: null }).catch(e => e);
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('skips models whose platform has no key', async () => {
    addKey('openrouter');
    const fn = mockFetch(() => json({ answers: ANSWERS, usage: {} }));
    const out = await runDecision(REQUEST, { clientAgent: null });
    expect(out.provider).toBe('openrouter');
    expect(calls(fn)).toHaveLength(1);
  });

  it('says how to fix it when no platform key exists', async () => {
    await expect(runDecision(REQUEST, { clientAgent: null })).rejects.toMatchObject({ status: 503, code: 'no_decision_keys' });
    expect(decisionsAvailable()).toBe(false);
  });

  it('rejects an unknown or turned-off model with a 400', async () => {
    addKey('openrouter');
    await expect(runDecision(REQUEST, { model: 'nope', clientAgent: null })).rejects.toMatchObject({ status: 400 });
    const id = listDecisionModels().find(m => m.platform === 'openrouter')!.id;
    expect(setDecisionModelEnabled(id, false)).toBe(true);
    await expect(runDecision(REQUEST, { model: 'inception/mercury-decide:free', clientAgent: null }))
      .rejects.toThrow(/turned off/);
  });

  it('does not pass an upstream 401 through as the caller\'s fault', async () => {
    addKey('cloudflare', 'acct:bad');
    mockFetch(() => json({ errors: [{ message: 'bad token' }] }, 401));
    const err = await runDecision(REQUEST, { model: '@cf/cloudflare/clef-flash', clientAgent: null }).catch(e => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.status).toBe(502);
  });

  it('treats a Cloudflare success:false body as a failure', async () => {
    addKey('cloudflare', 'acct:tok');
    mockFetch(() => json({ success: false, errors: [{ message: 'model error' }] }));
    await expect(runDecision(REQUEST, { model: '@cf/cloudflare/clef-flash', clientAgent: null })).rejects.toMatchObject({ status: 502 });
  });

  it('lists models with key counts and monthly usage', async () => {
    addKey('cloudflare', 'acct:tok');
    mockFetch(() => json({ success: true, result: { answers: ANSWERS, usage: { input_tokens: 10 } } }));
    await runDecision(REQUEST, { clientAgent: null });
    const [cf, or] = listDecisionModels();
    expect(cf).toMatchObject({ modelId: '@cf/cloudflare/clef-flash', enabled: true, keyCount: 1, healthyKeyCount: 1, decisionsThisMonth: 1, contextWindow: 24576 });
    expect(or).toMatchObject({ modelId: 'inception/mercury-decide:free', keyCount: 0, decisionsThisMonth: 0 });
  });

  it('keeps decision models off the image/audio media list', () => {
    expect(listAllMediaModels().some(m => m.modality === 'decision')).toBe(false);
  });

  it('only toggles decision rows', () => {
    getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
                     VALUES ('cloudflare', 'img', 'Img', 'image', 0, 1, '')`).run();
    const imageId = (getDb().prepare("SELECT id FROM media_models WHERE model_id = 'img'").get() as { id: number }).id;
    expect(setDecisionModelEnabled(imageId, false)).toBe(false);
  });
});
