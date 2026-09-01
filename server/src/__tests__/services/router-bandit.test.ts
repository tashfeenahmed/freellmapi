import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  routeRequest, refreshStatsCache, getRoutingStrategy, setRoutingStrategy, getRoutingScores,
  getCustomWeights, setCustomWeights, getExploreEnabled, setExploreEnabled,
  getCommunityPrior, setCommunityPriors, getCommunityPriorEnabled, setCommunityPriorEnabled,
  getPeakHoursConfig, setPeakHoursConfig,
} from '../../services/router.js';
import { BANDIT_PRESETS, DEFAULT_PEAK_HOURS } from '../../services/scoring.js';
import { resetModelWeightOverrides } from '../../services/model-weight-overrides.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';
import { addToActiveChain } from '../helpers/chain.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// Insert a model + its fallback entry; returns the model id.
function addModel(opts: {
  platform: string; modelId: string; name: string;
  intelligenceRank: number; sizeLabel: string; budget: string; priority: number;
  vision?: boolean;
}): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1)
  `).run(opts.platform, opts.modelId, opts.name, opts.intelligenceRank, 1, opts.sizeLabel, opts.budget, opts.vision ? 1 : 0);
  const id = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(opts.platform, opts.modelId) as { id: number }).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, opts.priority);
  addToActiveChain(id, opts.priority);
  // every platform needs at least one healthy key to be routable
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(opts.platform);
  return id;
}

// Insert N request rows (now → age 0, decay weight 1) for stats.
function addHistory(platform: string, modelId: string, opts: {
  successes: number; failures: number; outTokens?: number; latencyMs?: number; ttfbMs?: number | null;
}) {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?)
  `);
  for (let i = 0; i < opts.successes; i++) {
    ins.run(platform, modelId, 'success', opts.outTokens ?? 100, opts.latencyMs ?? 1000, null, opts.ttfbMs ?? null);
  }
  for (let i = 0; i < opts.failures; i++) {
    ins.run(platform, modelId, 'error', 0, opts.latencyMs ?? 1000, 'boom', opts.ttfbMs ?? null);
  }
}

function pickCounts(runs: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const r = routeRequest(100);
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
  }
  return counts;
}

describe('bandit router', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    // initDb seeds the real catalog; wipe it so each test controls its own
    // models/keys/history (and seeded models don't share a platform with ours).
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('strategy persists to and from settings; defaults to balanced', () => {
    expect(getRoutingStrategy()).toBe('balanced');
    setRoutingStrategy('smartest');
    expect(getRoutingStrategy()).toBe('smartest');
    setRoutingStrategy('priority');
    expect(getRoutingStrategy()).toBe('priority');
  });

  it('priority strategy follows the manual chain order deterministically', () => {
    addModel({ platform: 'google', modelId: 'a', name: 'A', intelligenceRank: 9, sizeLabel: 'Small', budget: '~10M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'b', name: 'B', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~10M', priority: 2 });
    setRoutingStrategy('priority');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(50);
    expect(counts['a']).toBe(50); // priority 1 always wins regardless of intelligence
  });

  it('balanced strategy favors the more reliable model', () => {
    addModel({ platform: 'google', modelId: 'good', name: 'Good', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'flaky', name: 'Flaky', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', priority: 2 });
    addHistory('google', 'good', { successes: 60, failures: 1 });
    addHistory('groq', 'flaky', { successes: 5, failures: 40 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(300);
    expect(counts['good'] ?? 0).toBeGreaterThan((counts['flaky'] ?? 0) * 3);
  });

  it('explores unseen models — both get picked at least once', () => {
    addModel({ platform: 'google', modelId: 'x', name: 'X', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'y', name: 'Y', intelligenceRank: 3, sizeLabel: 'Large', budget: '~50M', priority: 2 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(200);
    expect(counts['x'] ?? 0).toBeGreaterThan(0);
    expect(counts['y'] ?? 0).toBeGreaterThan(0);
  });

  it('exploration draws are never wasted on a model that cannot serve the request', () => {
    // vision-a is measured and wins every ordinary bandit draw. text-b and
    // vision-c are both unmeasured, but only vision-c can serve a vision
    // request. The pre-fix router put BOTH in the explore pool, so ~half the
    // explore draws promoted text-b, which the main loop's vision gate then
    // skipped — a wasted draw. With the pool filtered, vision-c receives
    // every explore draw (~10% of requests); unfixed it got only ~5%, far
    // below the 150/2000 bound asserted here.
    setExploreEnabled(true);
    addModel({ platform: 'google', modelId: 'vision-a', name: 'Vision A', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1, vision: true });
    addModel({ platform: 'groq', modelId: 'text-b', name: 'Text B', intelligenceRank: 2, sizeLabel: 'Frontier', budget: '~50M', priority: 2 });
    addModel({ platform: 'google', modelId: 'vision-c', name: 'Vision C', intelligenceRank: 30, sizeLabel: 'Small', budget: '~50M', priority: 3, vision: true });
    addHistory('google', 'vision-a', { successes: 500, failures: 0, outTokens: 1000, latencyMs: 300, ttfbMs: 100 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);

    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const r = routeRequest(100, undefined, undefined, /*requireVision=*/ true);
      counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
    }
    // The loop gate already guarantees this half; the pool filter is what the
    // vision-c bound below actually pins down.
    expect(counts['text-b'] ?? 0).toBe(0);
    expect(counts['vision-c'] ?? 0).toBeGreaterThan(150);
  });

  it('smartest vs fastest flips which model wins, at equal reliability', () => {
    // Smart: frontier tier, slow. Fast: small tier, high throughput. Equal success.
    addModel({ platform: 'google', modelId: 'smart', name: 'Smart', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'fast', name: 'Fast', intelligenceRank: 9, sizeLabel: 'Small', budget: '~50M', priority: 2 });
    addHistory('google', 'smart', { successes: 40, failures: 1, outTokens: 100, latencyMs: 3000, ttfbMs: 2500 });
    addHistory('groq', 'fast', { successes: 40, failures: 1, outTokens: 1000, latencyMs: 1000, ttfbMs: 150 });

    setRoutingStrategy('smartest');
    refreshStatsCache(getDb(), true);
    const smartRun = pickCounts(300);
    expect((smartRun['smart'] ?? 0)).toBeGreaterThan(smartRun['fast'] ?? 0);

    setRoutingStrategy('fastest');
    refreshStatsCache(getDb(), true);
    const fastRun = pickCounts(300);
    expect((fastRun['fast'] ?? 0)).toBeGreaterThan(fastRun['smart'] ?? 0);
  });

  it('custom weights persist normalized; default to balanced until saved', () => {
    expect(getCustomWeights()).toEqual({ reliability: 0.5, speed: 0.25, intelligence: 0.25 });
    setCustomWeights({ reliability: 0.6, speed: 0.3, intelligence: 0.1 });
    const w = getCustomWeights();
    expect(w.reliability).toBeCloseTo(0.6, 10);
    expect(w.speed).toBeCloseTo(0.3, 10);
    expect(w.intelligence).toBeCloseTo(0.1, 10);
    // Non-normalized input is normalized on save.
    setCustomWeights({ reliability: 1, speed: 1, intelligence: 0 });
    expect(getCustomWeights()).toEqual({ reliability: 0.5, speed: 0.5, intelligence: 0 });
  });

  it('custom weights reject all-zero and negative vectors', () => {
    expect(() => setCustomWeights({ reliability: 0, speed: 0, intelligence: 0 })).toThrow();
    expect(() => setCustomWeights({ reliability: -1, speed: 1, intelligence: 1 })).toThrow();
  });

  it('custom strategy routes with the saved weights (extreme speed wins)', () => {
    addModel({ platform: 'google', modelId: 'smart', name: 'Smart', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'fast', name: 'Fast', intelligenceRank: 9, sizeLabel: 'Small', budget: '~50M', priority: 2 });
    addHistory('google', 'smart', { successes: 40, failures: 1, outTokens: 100, latencyMs: 3000, ttfbMs: 2500 });
    addHistory('groq', 'fast', { successes: 40, failures: 1, outTokens: 1000, latencyMs: 1000, ttfbMs: 150 });

    setRoutingStrategy('custom');
    setCustomWeights({ reliability: 0.1, speed: 0.9, intelligence: 0 });
    refreshStatsCache(getDb(), true);
    const counts = pickCounts(300);
    expect((counts['fast'] ?? 0)).toBeGreaterThan(counts['smart'] ?? 0);

    const { strategy, weights } = getRoutingScores();
    expect(strategy).toBe('custom');
    expect(weights).toEqual({ reliability: 0.1, speed: 0.9, intelligence: 0 });
  });

  it('getRoutingScores returns a per-axis breakdown ranked by score', () => {
    // The peak-hours adjustment (#760) is opt-in and off here, so the preset is
    // returned verbatim — but the clock is still pinned to off-peak noon so this
    // assertion can never depend on when CI happens to run.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00'));
    try {
      addModel({ platform: 'google', modelId: 'm1', name: 'M1', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
      addHistory('google', 'm1', { successes: 30, failures: 0, outTokens: 500, latencyMs: 1000, ttfbMs: 200 });
      setRoutingStrategy('balanced');
      refreshStatsCache(getDb(), true);
      const { strategy, weights, scores } = getRoutingScores();
      expect(strategy).toBe('balanced');
      expect(weights).toEqual({ reliability: 0.5, speed: 0.25, intelligence: 0.25 });
      expect(scores).toHaveLength(1);
      expect(scores[0]).toMatchObject({ modelId: 'm1', enabled: true });
      expect(scores[0].reliability).toBeGreaterThan(0.9);
      expect(scores[0].score).toBeGreaterThan(0);
      expect(scores[0].score).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('peak-hours settings persist and default to off with the stock window', () => {
    expect(getPeakHoursConfig()).toEqual(DEFAULT_PEAK_HOURS);
    setPeakHoursConfig({ enabled: true, startHour: 9, endHour: 17, timezone: 'Asia/Kolkata' });
    expect(getPeakHoursConfig()).toEqual({ enabled: true, startHour: 9, endHour: 17, timezone: 'Asia/Kolkata' });
    setPeakHoursConfig({ enabled: false });
    expect(getPeakHoursConfig().enabled).toBe(false);
  });

  it('rejects an out-of-range hour or an unknown timezone', () => {
    expect(() => setPeakHoursConfig({ startHour: 24 })).toThrow(/peakStartHour/);
    expect(() => setPeakHoursConfig({ startHour: -1 })).toThrow(/peakStartHour/);
    expect(() => setPeakHoursConfig({ endHour: 6.5 })).toThrow(/peakEndHour/);
    expect(() => setPeakHoursConfig({ timezone: 'Not/AZone' })).toThrow(/peakTimezone/);
    // Nothing was written by the rejected calls.
    expect(getPeakHoursConfig()).toEqual(DEFAULT_PEAK_HOURS);
  });

  it('leaves preset weights alone while the peak adjustment is off (#760)', () => {
    vi.useFakeTimers();
    // 20:00 UTC — squarely inside the default 18:00–06:00 window.
    vi.setSystemTime(new Date('2026-01-15T20:00:00Z'));
    try {
      addModel({ platform: 'google', modelId: 'm1', name: 'M1', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
      refreshStatsCache(getDb(), true);
      for (const strategy of ['balanced', 'smartest', 'fastest', 'reliable'] as const) {
        setRoutingStrategy(strategy);
        const { weights, peakAdjusted } = getRoutingScores();
        expect(weights).toEqual(BANDIT_PRESETS[strategy]);
        expect(peakAdjusted).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('shifts speed onto reliability inside the window, in the configured timezone (#760)', () => {
    vi.useFakeTimers();
    // 13:00 UTC = 18:30 in Kolkata (inside 18:00–06:00) and 13:00 in UTC (outside).
    vi.setSystemTime(new Date('2026-01-15T13:00:00Z'));
    try {
      addModel({ platform: 'google', modelId: 'm1', name: 'M1', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
      refreshStatsCache(getDb(), true);
      setRoutingStrategy('balanced');

      setPeakHoursConfig({ enabled: true, timezone: 'Asia/Kolkata' });
      const inside = getRoutingScores();
      expect(inside.peakAdjusted).toBe(true);
      expect(inside.weights).toEqual({ reliability: 0.65, speed: 0.1, intelligence: 0.25 });

      // Same instant, same flag — only the timezone moves it out of the window.
      setPeakHoursConfig({ timezone: 'UTC' });
      const outside = getRoutingScores();
      expect(outside.peakAdjusted).toBe(false);
      expect(outside.weights).toEqual(BANDIT_PRESETS.balanced);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exempts fastest and reliable from the peak adjustment (#760)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T20:00:00Z')); // inside the default window
    try {
      addModel({ platform: 'google', modelId: 'm1', name: 'M1', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
      refreshStatsCache(getDb(), true);
      setPeakHoursConfig({ enabled: true, timezone: 'UTC' });

      for (const strategy of ['fastest', 'reliable'] as const) {
        setRoutingStrategy(strategy);
        const { weights, peakAdjusted } = getRoutingScores();
        expect(weights).toEqual(BANDIT_PRESETS[strategy]);
        expect(peakAdjusted).toBe(false);
      }
      for (const strategy of ['balanced', 'smartest'] as const) {
        setRoutingStrategy(strategy);
        expect(getRoutingScores().peakAdjusted).toBe(true);
      }
      // 'custom' is the operator's own vector and is never rewritten either.
      setCustomWeights({ reliability: 0.1, speed: 0.9, intelligence: 0 });
      setRoutingStrategy('custom');
      const custom = getRoutingScores();
      expect(custom.weights).toEqual({ reliability: 0.1, speed: 0.9, intelligence: 0 });
      expect(custom.peakAdjusted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exploration toggle persists and defaults to off', () => {
    expect(getExploreEnabled()).toBe(false);
    setExploreEnabled(true);
    expect(getExploreEnabled()).toBe(true);
    setExploreEnabled(false);
    expect(getExploreEnabled()).toBe(false);
  });

  it('exploration toggle gives an unmeasured model a chance to be tried', () => {
    // A measured model that wins every bandit draw, plus a brand-new model with
    // no reliability/speed samples. With the toggle off the new model is never
    // routed; with it on it must appear within a bounded number of requests.
    addModel({ platform: 'google', modelId: 'old', name: 'Old', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'new', name: 'New', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 2 });
    addHistory('google', 'old', { successes: 500, failures: 0, outTokens: 1000, latencyMs: 300, ttfbMs: 100 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);

    // Toggle off: the unmeasured model loses every draw.
    setExploreEnabled(false);
    const without = pickCounts(200);
    expect(without['new'] ?? 0).toBe(0);

    // Toggle on: 10% per request → over 500 requests the new model must appear.
    setExploreEnabled(true);
    const withExplore = pickCounts(500);
    expect(withExplore['new'] ?? 0).toBeGreaterThan(0);
  });

  it('exploration never probes a model zeroed out via MODEL_ROUTING_OVERRIDES (#738)', () => {
    // A weight-0 model never wins a bandit draw, so it never accumulates the
    // samples that would graduate it out of the unmeasured pool — without the
    // probe exclusion it would receive explore traffic forever.
    addModel({ platform: 'google', modelId: 'old', name: 'Old', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'new', name: 'New', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 2 });
    addHistory('google', 'old', { successes: 500, failures: 0, outTokens: 1000, latencyMs: 300, ttfbMs: 100 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);
    setExploreEnabled(true);

    const prev = process.env.MODEL_ROUTING_OVERRIDES;
    process.env.MODEL_ROUTING_OVERRIDES = '{"new": 0}';
    resetModelWeightOverrides();
    try {
      const counts = pickCounts(500);
      expect(counts['new'] ?? 0).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.MODEL_ROUTING_OVERRIDES;
      else process.env.MODEL_ROUTING_OVERRIDES = prev;
      resetModelWeightOverrides();
    }
  });

  it('community priors persist, drop invalid entries, and cap effective sample size (#685)', () => {
    expect(getCommunityPrior('groq', 'llama', undefined)).toBeUndefined();

    // Invalid entries (negative, all-zero, missing ':') are dropped.
    const kept = setCommunityPriors({
      'groq:llama': { successes: 980, failures: 20 },
      'groq:small': { successes: 30, failures: 10 },
      'bad:key': { successes: -5, failures: 1 },
      'allzero': { successes: 0, failures: 0 },
      'no-sep': { successes: 1, failures: 1 },
    });
    expect(kept).toBe(2);

    // Oversized priors are rescaled to at most COMMUNITY_PRIOR_MAX_SAMPLES
    // pseudo-observations, preserving the success/failure ratio; the capped
    // form is what persists (fresh read from settings).
    expect(getCommunityPrior('groq', 'llama', undefined))
      .toEqual({ successes: 49, failures: 1 });
    // Priors already under the cap are stored untouched.
    expect(getCommunityPrior('groq', 'small', undefined))
      .toEqual({ successes: 30, failures: 10 });
  });

  it('community priors are ignored until the opt-in flag is on (#685)', () => {
    // A model with no local samples reads as 0.5 (uniform prior). A stored
    // community record must NOT move that while the flag is off (default).
    addModel({ platform: 'google', modelId: 'g1', name: 'G1', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);

    const plain = getRoutingScores();
    expect(plain.scores[0]!.reliability).toBeCloseTo(0.5, 2);

    setCommunityPriors({ 'google:g1': { successes: 980, failures: 20 } });
    expect(getCommunityPriorEnabled()).toBe(false);
    const gated = getRoutingScores();
    expect(gated.scores[0]!.reliability).toBeCloseTo(0.5, 2);

    // Flag on → the (capped) prior seeds the axis near the community rate.
    setCommunityPriorEnabled(true);
    expect(getCommunityPriorEnabled()).toBe(true);
    const seeded = getRoutingScores();
    expect(seeded.scores[0]!.reliability).toBeGreaterThan(0.9);
  });

  it('local failures override a capped community prior (#685)', () => {
    // 5 local successes vs 95 failures: even with a glowing (capped) community
    // record the displayed reliability must fall well below the prior's rate —
    // a huge upstream count can no longer pin a locally-broken model at ~0.98.
    addModel({ platform: 'google', modelId: 'g1', name: 'G1', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addHistory('google', 'g1', { successes: 5, failures: 95 });
    setRoutingStrategy('balanced');
    setCommunityPriors({ 'google:g1': { successes: 980, failures: 20 } });
    setCommunityPriorEnabled(true);
    refreshStatsCache(getDb(), true);

    const { scores } = getRoutingScores();
    expect(scores[0]!.reliability).toBeLessThan(0.5);
  });

  it('tiny community priors vanish under real local traffic (#685)', () => {
    // A small pessimistic prior barely moves a model with hundreds of local
    // successes: local evidence dominates.
    addModel({ platform: 'google', modelId: 'g1', name: 'G1', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addHistory('google', 'g1', { successes: 480, failures: 20 });
    setRoutingStrategy('balanced');
    setCommunityPriorEnabled(true);
    refreshStatsCache(getDb(), true);

    const localOnly = getRoutingScores().scores[0]!.reliability;

    setCommunityPriors({ 'google:g1': { successes: 1, failures: 9 } });
    refreshStatsCache(getDb(), true);
    const withPrior = getRoutingScores().scores[0]!.reliability;

    expect(withPrior).toBeGreaterThan(0.9);
    expect(Math.abs(localOnly - withPrior)).toBeLessThan(0.03);
  });

  it('a saved intelligence_rank override visibly moves the axis (#673)', () => {
    // Regression for #673. A realistic chain: a Frontier flagship on top, a
    // Medium model at the bottom, and the Large model in between — the one the
    // user re-ranks from 6 to 1 ("this is actually the best model I have").
    //
    // Under the old LINEAR rank term that edit shifted the Large model's
    // normalized axis by ~0.25 points out of 100, i.e. the dashboard rendered
    // the SAME integer before and after and the edit looked like a no-op. The
    // sqrt-compressed term moves it ~2 points, which is visible.
    addModel({ platform: 'google', modelId: 'flagship', name: 'Flagship', intelligenceRank: 1, sizeLabel: 'Frontier', budget: '~50M', priority: 1 });
    addModel({ platform: 'groq', modelId: 'workhorse', name: 'Workhorse', intelligenceRank: 6, sizeLabel: 'Large', budget: '~50M', priority: 2 });
    addModel({ platform: 'meta', modelId: 'compact', name: 'Compact', intelligenceRank: 50, sizeLabel: 'Medium', budget: '~50M', priority: 3 });
    setRoutingStrategy('balanced');
    refreshStatsCache(getDb(), true);

    const before = getRoutingScores().scores.find(s => s.modelId === 'workhorse')!;

    // PATCH /api/models/:id { intelligenceRank: 1 } bottoms out in exactly this
    // UPDATE (routes/models.ts maps intelligenceRank → the intelligence_rank
    // column); this suite drives the router directly and has no HTTP harness,
    // so write the column and refresh the cache the same way the route does.
    const row = getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get('groq', 'workhorse') as { id: number };
    getDb().prepare('UPDATE models SET intelligence_rank = 1 WHERE id = ?').run(row.id);
    refreshStatsCache(getDb(), true);

    const after = getRoutingScores().scores.find(s => s.modelId === 'workhorse')!;

    // The dashboard renders Math.round(value * 100) (client AxisBar), so assert
    // on the number the user actually sees: it must move by at least 2 points.
    const shown = (v: number) => Math.round(v * 100);
    expect(shown(after.intelligence)).toBeGreaterThanOrEqual(shown(before.intelligence) + 2);
  });
});
