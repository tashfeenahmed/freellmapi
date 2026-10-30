import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Free-only routing (services/free-only.ts): automatic routing may only reach
// documented free access, explicit requests may also use access that cannot
// bill (trial keys, the operator's own custom endpoints), and anything that
// can consume credit or be billed needs FREE_ONLY_ALLOW_PLATFORMS.

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return { ...actual, canMakeRequest: vi.fn(() => true), canUseTokens: vi.fn(() => true), isOnCooldown: vi.fn(() => false) };
});
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

import {
  freeOnlyDecision, freeOnlyPolicySummary, isFreeOnlyEnabled, optedInPlatforms, warnFreeOnlyPolicy,
} from '../../services/free-only.js';
import { routeRequest, routePinnedModel, getOrderedFusionChain, setRoutingStrategy } from '../../services/router.js';
import { getDb, initDb } from '../../db/index.js';

const ENV = ['FREE_ONLY_ROUTING', 'FREE_ONLY_ALLOW_PLATFORMS', 'DEV_MODE', 'NODE_ENV'] as const;
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
function restoreEnv() {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe('freeOnlyDecision: automatic routing', () => {
  beforeEach(() => { delete process.env.FREE_ONLY_ROUTING; delete process.env.FREE_ONLY_ALLOW_PLATFORMS; });
  afterEach(restoreEnv);

  it('is on by default', () => {
    expect(isFreeOnlyEnabled()).toBe(true);
  });

  it.each([
    ['google', 'gemini-3.5-flash'],
    ['google', 'gemma-4-31b-it'],
    ['groq', 'openai/gpt-oss-120b'],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free'],
    ['zhipu', 'glm-4.7-flash'],
  ])('allows documented free access: %s/%s', (platform, model) => {
    expect(freeOnlyDecision(platform, model, 'automatic')).toEqual({ allowed: true });
  });

  it.each([
    ['google', 'gemini-2.5-pro', /outside the provider's free models/],
    ['openrouter', 'anthropic/claude-opus', /outside the provider's free models/],
    ['cohere', 'command-a-03-2025', /trial access/],
    ['huggingface', 'Qwen/Qwen3-Coder-Next', /free-recurring-credit access/],
    ['sail', 'any', /paid-beyond-free access/],
    ['reka', 'reka-flash', /paid access/],
    ['agnes', 'agnes-1', /promotional access/],
    ['sambanova', 'x', /retired access/],
    ['blaze', 'x', /unknown access/],
    ['not-a-platform', 'x', /unknown access/],
    ['custom', 'llama3:8b', /custom endpoint/],
    ['kilo', 'poolside/laguna-m.1:free', /logs prompts for training/],
    ['aclide', 'x', /not documented well enough/],
    ['requesty', 'some/model', /not documented well enough/],
  ])('blocks %s/%s', (platform, model, reason) => {
    const d = freeOnlyDecision(platform, model, 'automatic');
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(reason);
    expect(d.reason).toContain(`FREE_ONLY_ALLOW_PLATFORMS=${platform}`);
  });
});

describe('freeOnlyDecision: explicit requests', () => {
  beforeEach(() => { delete process.env.FREE_ONLY_ROUTING; delete process.env.FREE_ONLY_ALLOW_PLATFORMS; });
  afterEach(restoreEnv);

  it.each([
    ['cohere', 'command-a-03-2025'], // trial key: cannot bill
    ['custom', 'llama3:8b'], // the operator's own endpoint
    ['aclide', 'x'], // documented free, low confidence: the client chose it
    ['google', 'gemini-3.5-flash'],
  ])('allows %s/%s when the client names it', (platform, model) => {
    expect(freeOnlyDecision(platform, model, 'explicit').allowed).toBe(true);
  });

  it.each([
    ['huggingface', 'Qwen/Qwen3-Coder-Next'],
    ['sail', 'any'],
    ['agnes', 'agnes-1'],
    ['openrouter', 'anthropic/claude-opus'],
    ['google', 'gemini-2.5-pro'],
    ['blaze', 'x'],
    ['not-a-platform', 'x'],
  ])('still blocks %s/%s without an opt-in', (platform, model) => {
    expect(freeOnlyDecision(platform, model, 'explicit').allowed).toBe(false);
  });
});

describe('opt-in and opt-out', () => {
  afterEach(restoreEnv);

  it('FREE_ONLY_ALLOW_PLATFORMS opts a platform in for both modes, case-insensitively', () => {
    process.env.FREE_ONLY_ALLOW_PLATFORMS = ' Sail , custom,, bad id!, ../x ';
    expect([...optedInPlatforms()].sort()).toEqual(['custom', 'sail']);
    expect(freeOnlyDecision('sail', 'any', 'automatic').allowed).toBe(true);
    expect(freeOnlyDecision('sail', 'any', 'explicit').allowed).toBe(true);
    expect(freeOnlyDecision('custom', 'llama3:8b', 'automatic').allowed).toBe(true);
    expect(freeOnlyDecision('huggingface', 'x', 'automatic').allowed).toBe(false);
  });

  it.each(['off', 'OFF', '0', 'false', 'no', 'disabled'])('FREE_ONLY_ROUTING=%s turns the guard off', (value) => {
    process.env.FREE_ONLY_ROUTING = value;
    expect(isFreeOnlyEnabled()).toBe(false);
    expect(freeOnlyDecision('sail', 'any', 'automatic').allowed).toBe(true);
  });

  it.each(['', 'on', 'true', 'typo'])('FREE_ONLY_ROUTING=%j keeps the guard on', (value) => {
    process.env.FREE_ONLY_ROUTING = value;
    expect(isFreeOnlyEnabled()).toBe(true);
  });

  it('warns about risky opt-ins and a disabled guard, once per configuration', () => {
    const log = vi.fn();
    process.env.FREE_ONLY_ALLOW_PLATFORMS = 'sail,google';
    warnFreeOnlyPolicy(log);
    warnFreeOnlyPolicy(log);
    expect(log).toHaveBeenCalledTimes(1); // google needs no warning; sail does; repeat is silent
    expect(String(log.mock.calls[0][0])).toMatch(/sail is opted in.*billed/);
    process.env.FREE_ONLY_ROUTING = 'off';
    warnFreeOnlyPolicy(log);
    expect(String(log.mock.calls[1][0])).toMatch(/FREE_ONLY_ROUTING is off/);
    expect(freeOnlyPolicySummary()).toEqual({
      enabled: false,
      optedIn: [
        { platform: 'google', freeTier: 'free-recurring', warning: null },
        { platform: 'sail', freeTier: 'paid-beyond-free', warning: 'paid-beyond-free access can consume credit or be billed' },
      ],
    });
  });
});

// ── Through the real router ──────────────────────────────────────────────────

function insertModel(platform: string, modelId: string, priority: number): number {
  const db = getDb();
  db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES (?, ?, ?, 1, 1, 1)")
    .run(platform, modelId, modelId);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  return id;
}
function insertKey(platform: string) {
  getDb().prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)",
  ).run(platform);
}
function routeErrorMessage(fn: () => unknown): string {
  try { fn(); } catch (e: any) { return [e.message, ...(e.diagnostics ?? [])].join('\n'); }
  throw new Error('expected routing to fail');
}

describe('router enforcement', () => {
  let ids: Record<string, number>;
  beforeEach(() => {
    delete process.env.FREE_ONLY_ROUTING;
    delete process.env.FREE_ONLY_ALLOW_PLATFORMS;
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    setRoutingStrategy('priority');
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    for (const t of ['fallback_config', 'profile_models', 'models', 'api_keys']) db.prepare(`DELETE FROM ${t}`).run();
    // Paid and credit-based destinations rank ABOVE the free one on purpose.
    ids = {
      sail: insertModel('sail', 'sail-large', 1),
      hf: insertModel('huggingface', 'Qwen/Qwen3-Coder-Next', 2),
      orPaid: insertModel('openrouter', 'anthropic/claude-opus', 3),
      cohere: insertModel('cohere', 'command-a-03-2025', 4),
      gemini: insertModel('google', 'gemini-3.5-flash', 5),
    };
    for (const p of ['sail', 'huggingface', 'openrouter', 'cohere', 'google']) insertKey(p);
  });
  afterEach(restoreEnv);

  it('automatic routing skips every paid, credit, trial and non-free row and lands on Gemini', () => {
    const route = routeRequest(100);
    expect(route.platform).toBe('google');
    expect(route.modelId).toBe('gemini-3.5-flash');
  });

  it('with the free model unavailable, routing fails instead of falling back to a billable one', () => {
    const msg = routeErrorMessage(() => routeRequest(100, undefined, undefined, false, false, new Set([ids.gemini])));
    expect(msg).toMatch(/blocked by free-only routing/);
    for (const p of ['sail', 'huggingface', 'openrouter/anthropic', 'cohere']) expect(msg).toContain(p);
  });

  it('a sticky/preferred row without the explicit flag is still automatic', () => {
    // preferredModelDbId alone moves sail to the front but must not unlock it.
    expect(routeRequest(100, undefined, ids.sail).platform).toBe('google');
  });

  it('an explicitly named trial model is served; an explicitly named paid one is not', () => {
    const cohere = routeRequest(100, undefined, ids.cohere, false, false, undefined, undefined, false, undefined, 0, undefined, new Set([ids.cohere]));
    expect(cohere.platform).toBe('cohere');
    const sail = routeRequest(100, undefined, ids.sail, false, false, undefined, undefined, false, undefined, 0, undefined, new Set([ids.sail]));
    expect(sail.platform).toBe('google'); // never sail; failover stays on free rows
  });

  it('routePinnedModel applies the explicit policy', () => {
    expect(routePinnedModel(ids.cohere, 100)?.platform).toBe('cohere');
    expect(routePinnedModel(ids.sail, 100)).toBeNull();
    expect(routePinnedModel(ids.orPaid, 100)).toBeNull();
  });

  it('auto-picked fusion slots only come from automatically eligible rows', () => {
    const platforms = getOrderedFusionChain(100).map(c => c.platform);
    expect(platforms).toContain('google');
    for (const p of ['sail', 'huggingface', 'openrouter', 'cohere']) expect(platforms).not.toContain(p);
  });

  it('an opt-in makes the platform routable again', () => {
    process.env.FREE_ONLY_ALLOW_PLATFORMS = 'sail';
    expect(routeRequest(100).platform).toBe('sail');
  });

  it('FREE_ONLY_ROUTING=off restores the previous behaviour', () => {
    process.env.FREE_ONLY_ROUTING = 'off';
    expect(routeRequest(100).platform).toBe('sail');
  });
});

describe('exhaustion bodies', () => {
  it('reports a pure policy refusal as 403 free_only_blocked', async () => {
    const { routingExhaustionBody } = await import('../../lib/fallback-loop.js');
    const body = routingExhaustionBody({
      message: 'All models exhausted',
      diagnostics: [
        'sail/sail-large: blocked by free-only routing (paid-beyond-free access; set FREE_ONLY_ALLOW_PLATFORMS=sail to opt in)',
        '3 model(s) skipped: no enabled+healthy key for platform (groq, mistral, nvidia)',
      ],
    });
    expect(body).toMatchObject({ status: 403, type: 'permission_error', code: 'free_only_blocked', kind: 'bad_request' });
    expect(body.message).toContain('sail/sail-large');
  });

  it('keeps a 429 when a free provider is only rate-limited', async () => {
    const { routingExhaustionBody } = await import('../../lib/fallback-loop.js');
    const body = routingExhaustionBody({
      message: 'All models exhausted',
      diagnostics: [
        'sail/sail-large: blocked by free-only routing (paid-beyond-free access; set FREE_ONLY_ALLOW_PLATFORMS=sail to opt in)',
        'google/gemini-3.5-flash: all 1 key(s) — cooldown',
      ],
    });
    expect(body.status).toBe(429);
    expect(body.code).toBe('rate_limit_exceeded');
  });
});

describe('automaticDecision rule branch', () => {
  it('blocks a medium-confidence subset provider whose model no rule identifies', async () => {
    const { automaticDecision } = await import('../../services/free-only.js');
    const { getProviderMetadata } = await import('../../providers/metadata.js');
    const meta = { ...getProviderMetadata('requesty'), confidence: 'medium' as const };
    const d = automaticDecision(meta, 'some/model');
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no rule identifies this model as free/);
  });
});
