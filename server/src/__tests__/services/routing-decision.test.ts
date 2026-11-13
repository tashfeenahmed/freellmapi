import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response } from 'express';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { clientContextMiddleware, getClientContext } from '../../lib/client-context.js';
import { effectiveRoutingStrategy, setRoutingStrategy } from '../../services/router.js';
import {
  applyDecisionRouting,
  chooseRoutingPreset,
  decisionStateFor,
  getDecisionRoutingSettings,
  getDecisionRoutingStats,
  resetDecisionRoutingCache,
  routingStrategyHeader,
  setDecisionRoutingSettings,
  DECISION_TIMEOUT_MS,
  ROUTER_CLIENT,
} from '../../services/routing-decision.js';
import { seedDecisionModels } from '../helpers/decision-models.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const realFetch = globalThis.fetch;

function addKey(platform: string, raw = `${platform}-test-key`): void {
  const { encrypted, iv, authTag } = encrypt(raw);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
}

function cloudflareAnswer(choice: string, probability: number) {
  const probabilities: Record<string, number> = { smartest: 0, fastest: 0, balanced: 0, reliable: 0 };
  probabilities[choice] = probability;
  return new Response(JSON.stringify({
    success: true,
    result: { model: 'clef-flash', answers: { strategy: { type: 'choice', choice, probabilities, confidence: 0.5 } }, usage: { input_tokens: 250, output_tokens: 0 } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(String(url), init)));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** Run `fn` inside a request scope, the way every chat surface runs. */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const req = { headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
  return new Promise<T>((resolve, reject) => {
    clientContextMiddleware(req, {} as Response, () => { fn().then(resolve, reject); });
  });
}

const user = (content: ChatMessage['content']): ChatMessage => ({ role: 'user', content });
const HARD = [user('Prove that the square root of 2 is irrational, then generalise it.')];

describe('decision routing (#1354)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    seedDecisionModels();
    clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    resetDecisionRoutingCache();
    setRoutingStrategy('decision');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does nothing (no decision call) unless the decision strategy is active', async () => {
    setRoutingStrategy('balanced');
    addKey('cloudflare', 'acct:token');
    const fn = mockFetch(() => cloudflareAnswer('smartest', 0.9));
    expect(await applyDecisionRouting(HARD)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips the decision when the request pins a model', async () => {
    addKey('cloudflare', 'acct:token');
    const fn = mockFetch(() => cloudflareAnswer('smartest', 0.9));
    expect(await applyDecisionRouting(HARD, { pinned: true })).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('routes THIS request with the preset the decision model picked', async () => {
    addKey('cloudflare', 'acct:token');
    const fn = mockFetch(() => cloudflareAnswer('smartest', 0.82));
    const seen = await inRequest(async () => {
      const pick = await applyDecisionRouting(HARD);
      return { pick, strategy: effectiveRoutingStrategy(), ctx: getClientContext().routingStrategy };
    });
    expect(seen.pick).toEqual({ strategy: 'smartest', source: 'decision', probability: 0.82, model: '@cf/cloudflare/clef-flash' });
    expect(seen.strategy).toBe('smartest');
    expect(seen.ctx).toBe('smartest');
    // One choice question whose options are exactly the four presets.
    const body = JSON.parse((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(Object.keys(body.questions)).toEqual(['strategy']);
    expect(Object.keys(body.questions.strategy.criteria).sort()).toEqual(['balanced', 'fastest', 'reliable', 'smartest']);
    expect(body.state).toContain('square root of 2');
    // Logged as the router's own decision, not as the chat client's.
    const log = getDb().prepare('SELECT client_agent, status FROM decision_requests').all();
    expect(log).toEqual([{ client_agent: ROUTER_CLIENT, status: 'ok' }]);
  });

  it('does not leak a pick into another request', async () => {
    addKey('cloudflare', 'acct:token');
    mockFetch(() => cloudflareAnswer('fastest', 0.95));
    await inRequest(async () => { await applyDecisionRouting([user('hi')]); });
    const other = await inRequest(async () => effectiveRoutingStrategy());
    expect(other).toBe('balanced');
  });

  it('routes as Balanced when the decision model is unsure', async () => {
    addKey('cloudflare', 'acct:token');
    mockFetch(() => cloudflareAnswer('reliable', 0.31));
    const pick = await chooseRoutingPreset(HARD);
    expect(pick).toEqual({ strategy: 'balanced', source: 'low_confidence', probability: 0.31, model: '@cf/cloudflare/clef-flash' });
  });

  it('honours a custom minimum probability', async () => {
    addKey('cloudflare', 'acct:token');
    setDecisionRoutingSettings({ minProbability: 0.3 });
    mockFetch(() => cloudflareAnswer('reliable', 0.31));
    expect((await chooseRoutingPreset(HARD)).strategy).toBe('reliable');
  });

  it('re-judges when the minimum probability changes (cache is threshold-scoped)', async () => {
    // A low-confidence pick cached as Balanced must not outlive a lowering of
    // the threshold: the point of lowering it is to let the model's own pick
    // through for texts already judged during the cache TTL.
    addKey('cloudflare', 'acct:token');
    const fn = mockFetch(() => cloudflareAnswer('reliable', 0.31));
    expect(await chooseRoutingPreset(HARD)).toMatchObject({ strategy: 'balanced', source: 'low_confidence' });
    setDecisionRoutingSettings({ minProbability: 0.3 });
    const after = await chooseRoutingPreset(HARD);
    expect(after).toMatchObject({ strategy: 'reliable', source: 'decision' });
    expect(fn).toHaveBeenCalledTimes(2);
    // Same threshold again: answered from cache, no third call.
    expect(await chooseRoutingPreset(HARD)).toMatchObject({ strategy: 'reliable', source: 'cache' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('asks once per turn: the same text is answered from cache', async () => {
    addKey('cloudflare', 'acct:token');
    const fn = mockFetch(() => cloudflareAnswer('fastest', 0.9));
    expect((await chooseRoutingPreset([user('what is 2+2')])).source).toBe('decision');
    const again = await chooseRoutingPreset([user('what is 2+2'), { role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', content: '4', tool_call_id: 'x' }]);
    expect(again).toMatchObject({ strategy: 'fastest', source: 'cache' });
    expect(fn).toHaveBeenCalledTimes(1);
    await chooseRoutingPreset([user('a different question')]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('routes as Balanced on a slow decision instead of holding the request', async () => {
    addKey('cloudflare', 'acct:token');
    mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
    }));
    const started = Date.now();
    const pick = await chooseRoutingPreset(HARD);
    expect(pick).toEqual({ strategy: 'balanced', source: 'timeout' });
    expect(Date.now() - started).toBeLessThan(DECISION_TIMEOUT_MS + 1000);
  });

  it('routes as Balanced when no decision key exists, without calling anything', async () => {
    const fn = mockFetch(() => cloudflareAnswer('smartest', 0.9));
    expect(await chooseRoutingPreset(HARD)).toEqual({ strategy: 'balanced', source: 'unavailable' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('routes as Balanced when the decision call fails or answers off-list', async () => {
    addKey('cloudflare', 'acct:token');
    mockFetch(() => new Response('boom', { status: 500 }));
    expect(await chooseRoutingPreset(HARD)).toMatchObject({ strategy: 'balanced', source: 'error' });
    resetDecisionRoutingCache();
    mockFetch(() => cloudflareAnswer('turbo', 0.99));
    expect(await chooseRoutingPreset([user('another')])).toMatchObject({ strategy: 'balanced', source: 'error' });
  });

  it("leaves BeatAPI's 1-per-minute free routes out of 'auto'", async () => {
    getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
                     VALUES ('beatapi', 'jev-1.14-free', 'JEV', 'decision', -1, 1, '')`).run();
    addKey('beatapi', 'sk-beat');
    const fn = mockFetch(() => cloudflareAnswer('smartest', 0.9));
    expect(await chooseRoutingPreset(HARD)).toEqual({ strategy: 'balanced', source: 'unavailable' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('records picks and fallbacks for the dashboard', async () => {
    addKey('cloudflare', 'acct:token');
    mockFetch(() => cloudflareAnswer('fastest', 0.9));
    await applyDecisionRouting([user('hi')]);
    await applyDecisionRouting([]);
    const stats = getDecisionRoutingStats();
    expect(stats.counts).toEqual({ smartest: 0, fastest: 1, balanced: 1, reliable: 0 });
    expect(stats.fallbacks).toEqual({ unavailable: 1 });
    expect(stats.recent.map(r => r.source)).toEqual(['unavailable', 'decision']);
  });

  it('validates settings', () => {
    expect(getDecisionRoutingSettings()).toEqual({ model: 'auto', minProbability: 0.5 });
    expect(() => setDecisionRoutingSettings({ minProbability: 1.5 })).toThrow();
    expect(() => setDecisionRoutingSettings({ model: '  ' })).toThrow();
    setDecisionRoutingSettings({ model: 'inception/mercury-decide:free', minProbability: 0.7 });
    expect(getDecisionRoutingSettings()).toEqual({ model: 'inception/mercury-decide:free', minProbability: 0.7 });
  });

  it('labels fallbacks in the response header', () => {
    expect(routingStrategyHeader({ strategy: 'smartest', source: 'decision' })).toBe('smartest');
    expect(routingStrategyHeader({ strategy: 'fastest', source: 'cache' })).toBe('fastest');
    expect(routingStrategyHeader({ strategy: 'balanced', source: 'timeout' })).toBe('balanced; fallback=timeout');
  });
});

describe('decisionStateFor', () => {
  it('reads the system prompt opening and the latest user message', () => {
    const state = decisionStateFor([
      { role: 'system', content: 'You are a coding agent.' },
      user('first question'),
      { role: 'assistant', content: 'answer' },
      user([{ type: 'text', text: 'second question' }, { type: 'image_url', image_url: { url: 'x' } }]),
    ]);
    expect(state).toBe('System prompt (start): You are a coding agent.\n\nRequest: second question');
  });

  it('bounds a huge message and is empty without user text', () => {
    expect(decisionStateFor([user('x'.repeat(50_000))]).length).toBeLessThan(2_000);
    expect(decisionStateFor([{ role: 'system', content: 'only system' }])).toBe('');
  });
});

describe('effectiveRoutingStrategy', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('is the set strategy for every non-decision strategy', async () => {
    setRoutingStrategy('fastest');
    expect(await inRequest(async () => effectiveRoutingStrategy())).toBe('fastest');
  });

  it('is Balanced under decision until a preset is picked', async () => {
    setRoutingStrategy('decision');
    expect(effectiveRoutingStrategy()).toBe('balanced');
    expect(await inRequest(async () => effectiveRoutingStrategy())).toBe('balanced');
  });
});

describe('decision routing status (setup guide)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    resetDecisionRoutingCache();
  });

  it('has no models to offer before the catalog delivers any', async () => {
    const { getDecisionRoutingStatus } = await import('../../services/routing-decision.js');
    expect(getDecisionRoutingStatus()).toMatchObject({ ready: false, hasModels: false, keyPlatforms: [] });
  });

  it('names the providers whose key would make it ready, until one exists', async () => {
    const { getDecisionRoutingStatus } = await import('../../services/routing-decision.js');
    seedDecisionModels();
    expect(getDecisionRoutingStatus()).toMatchObject({ ready: false, hasModels: true, keyPlatforms: ['cloudflare', 'openrouter'] });
    addKey('openrouter', 'sk-or');
    expect(getDecisionRoutingStatus()).toMatchObject({ ready: true, keyPlatforms: ['cloudflare', 'openrouter'] });
  });

  it("does not count a BeatAPI key as ready under 'auto', but does when BeatAPI is pinned", async () => {
    const { getDecisionRoutingStatus } = await import('../../services/routing-decision.js');
    getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
                     VALUES ('beatapi', 'jev-1.14-free', 'JEV', 'decision', 0, 1, '')`).run();
    addKey('beatapi', 'sk-beat');
    expect(getDecisionRoutingStatus()).toMatchObject({ ready: false, hasModels: false, keyPlatforms: [] });
    setDecisionRoutingSettings({ model: 'jev-1.14-free' });
    expect(getDecisionRoutingStatus()).toMatchObject({ ready: true, hasModels: true, keyPlatforms: ['beatapi'] });
  });
});
