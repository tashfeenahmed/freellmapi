import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { isPermanentModelUnavailableError, modelRetirementSignal } from '../../lib/error-classify.js';
import {
  noteModelRetirementSignal,
  resetModelRetirementObservations,
  RETIREMENT_CONFIRMATIONS_REQUIRED,
} from '../../services/model-retirement.js';
import { getCatalogModelTombstone, recordCatalogModelTombstone } from '../../services/model-state.js';
import { applyCatalog } from '../../services/catalog-sync.js';

// #634: NVIDIA retires a model upstream ("has reached its end of life"), and
// every subsequent request burns a fallback slot on the corpse because nothing
// persisted the 404/410. These tests lock the two halves of the fix: a
// conservative end-of-life CLASSIFIER (transient 404s must never match), and a
// corroboration threshold before the model is actually auto-disabled.

const PLATFORM = 'groq';
const MODEL_ID = 'eol-test-model';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

function seedModel(modelId = MODEL_ID): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, 'EOL Test', 50, 50, 1, 'catalog')
    ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET enabled = 1
  `).run(PLATFORM, modelId);
  const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(PLATFORM, modelId) as { id: number };
  db.prepare(`
    INSERT INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, 999, 1)
    ON CONFLICT(model_db_id) DO UPDATE SET enabled = 1
  `).run(row.id);
  return row.id;
}

function isRoutable(modelDbId: number): boolean {
  const row = getDb()
    .prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?')
    .get(modelDbId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function routeFor(modelDbId: number, modelId = MODEL_ID) {
  return { modelDbId, platform: PLATFORM, modelId };
}

// The exact NVIDIA body from issue #634.
const NVIDIA_EOL = Object.assign(
  new Error(
    "NVIDIA NIM API error 410: The model 'minimaxai/minimax-m2.7' has reached its end of life "
    + 'on 2026-07-27T00:00:00Z and is no longer available.',
  ),
  { status: 410 },
);

const FREE_PLAN_ENDED = Object.assign(
  new Error('Provider API error 403: this model is not available on the free plan'),
  { status: 403 },
);

// The transient shape from the same issue thread: a load balancer that cannot
// find the function for the account right now. Says nothing about the model.
const TRANSIENT_404 = Object.assign(
  new Error(
    "NVIDIA NIM API error 404: Function '23d4f03a-b8a6-4adb-a183-7daa083a09cc': Not found for account 'BDnmPUMI'",
  ),
  { status: 404 },
);

describe('modelRetirementSignal (conservative end-of-life detection — #634)', () => {
  it('treats an explicit 410 / end-of-life body as definitive', () => {
    expect(modelRetirementSignal(NVIDIA_EOL)).toBe('definitive');
    expect(modelRetirementSignal(Object.assign(new Error('Gone'), { status: 410 }))).toBe('definitive');
    expect(modelRetirementSignal(new Error('Ollama Cloud API error 410: Gone'))).toBe('definitive');
    // The wording alone is definitive even when the provider picks a 404.
    expect(modelRetirementSignal(Object.assign(
      new Error('API error 404: model has reached its end of life'),
      { status: 404 },
    ))).toBe('definitive');
  });

  // 'definitive' skips the corroboration gate and disables the model on ONE
  // response, so the phrase must not be load-bearing by itself: a rate-limit
  // or server-error body can quote a retirement notice (about this model or
  // another) without the model being gone.
  it('ignores an end-of-life phrase when the status does not agree the model is gone', () => {
    expect(modelRetirementSignal(Object.assign(
      new Error('Rate limit exceeded. Note: llama-3.1-8b reaches end of life on 2026-12-01'),
      { status: 429 },
    ))).toBeNull();
    expect(modelRetirementSignal(Object.assign(
      new Error('Internal server error: upstream pool has been decommissioned'),
      { status: 500 },
    ))).toBeNull();
    expect(modelRetirementSignal(Object.assign(
      new Error('Bad request: the v1 endpoint has been sunset, use v2'),
      { status: 400 },
    ))).toBeNull();
  });

  it('still fires when a gone-shaped status carries the phrase', () => {
    expect(modelRetirementSignal(Object.assign(
      new Error('API error 410: this model has been retired'),
      { status: 410 },
    ))).toBe('definitive');
    expect(modelRetirementSignal(Object.assign(
      new Error('API error 404: this model has been decommissioned'),
      { status: 404 },
    ))).toBe('definitive');
  });

  it('treats a 404 that clearly says the model is gone as probable (needs corroboration)', () => {
    expect(modelRetirementSignal(Object.assign(
      new Error('OpenRouter API error 404: this model is no longer available'),
      { status: 404 },
    ))).toBe('probable');
    expect(modelRetirementSignal(Object.assign(
      new Error('Groq API error 404: model has been removed'),
      { status: 404 },
    ))).toBe('probable');
  });

  it('recognizes an explicit permanent free-plan gate but not resettable quota', () => {
    const permanent = Object.assign(
      new Error('Provider API error 403: this model is not available on the free plan'),
      { status: 403 },
    );
    const resettable = Object.assign(
      new Error('Provider API error 402: free tier quota resets monthly; upgrade is optional'),
      { status: 402 },
    );

    expect(isPermanentModelUnavailableError(permanent)).toBe(true);
    expect(modelRetirementSignal(permanent)).toBe('definitive');
    expect(isPermanentModelUnavailableError(resettable)).toBe(false);
    expect(modelRetirementSignal(resettable)).toBeNull();
    expect(isPermanentModelUnavailableError(Object.assign(new Error('insufficient balance'), { status: 402 }))).toBe(false);
  });

  it('never fires on transient 404s, empty not-found bodies, or unrelated failures', () => {
    expect(modelRetirementSignal(TRANSIENT_404)).toBeNull();
    expect(modelRetirementSignal(new Error('OpenRouter API error 404: Provider returned error'))).toBeNull();
    expect(modelRetirementSignal(new Error('Model not found'))).toBeNull();
    // OpenRouter says this while a model is merely unserved right now.
    expect(modelRetirementSignal(new Error('No endpoints found for openrouter/minimax/minimax-m2.5:free'))).toBeNull();
    expect(modelRetirementSignal(new Error('429 Too Many Requests'))).toBeNull();
    expect(modelRetirementSignal(new Error('503 Service Unavailable'))).toBeNull();
    // A digit run that merely contains 410 is not a 410.
    expect(modelRetirementSignal(new Error('Groq API error 400: max_tokens 41000 exceeds 32768'))).toBeNull();
  });
});

describe('noteModelRetirementSignal (auto-disable with a reason — #634)', () => {
  beforeEach(() => {
    resetModelRetirementObservations();
    getDb().prepare("DELETE FROM catalog_model_tombstones WHERE model_id LIKE 'eol-test-%'").run();
  });

  it('deletes the model on a single explicit 410 end-of-life response', () => {
    const id = seedModel();
    expect(noteModelRetirementSignal(routeFor(id), NVIDIA_EOL, {})).toBe(true);
    expect(isRoutable(id)).toBe(false);
    expect(getDb().prepare('SELECT id FROM models WHERE id = ?').get(id)).toBeUndefined();

    const tombstone = getCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID);
    expect(tombstone?.source).toBe('upstream_permanent');
    expect(tombstone?.reason).toContain('end of life');
  });

  it('deletes a model when the provider permanently ends free-plan access', () => {
    const id = seedModel('eol-test-paywalled');
    expect(noteModelRetirementSignal(routeFor(id, 'eol-test-paywalled'), FREE_PLAN_ENDED, {})).toBe(true);
    expect(getDb().prepare('SELECT id FROM models WHERE id = ?').get(id)).toBeUndefined();

    const tombstone = getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-test-paywalled');
    expect(tombstone?.source).toBe('upstream_permanent');
    expect(tombstone?.reason).toContain('not available on the free plan');

  });

  it('leaves a transient 404 alone no matter how often it repeats', () => {
    const id = seedModel();
    for (let i = 0; i < 5; i++) {
      expect(noteModelRetirementSignal(routeFor(id), TRANSIENT_404, {})).toBe(false);
    }
    expect(isRoutable(id)).toBe(true);
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID)).toBeUndefined();
  });

  it('requires corroboration from distinct requests before disabling on a probable 404', () => {
    const id = seedModel();
    const err = Object.assign(new Error('API error 404: this model is no longer available'), { status: 404 });

    expect(RETIREMENT_CONFIRMATIONS_REQUIRED).toBeGreaterThanOrEqual(2);
    expect(noteModelRetirementSignal(routeFor(id), err, {})).toBe(false);
    expect(isRoutable(id)).toBe(true);
    expect(noteModelRetirementSignal(routeFor(id), err, {})).toBe(true);
    expect(isRoutable(id)).toBe(false);
  });

  it('does not let one flaky request corroborate itself across sibling keys', () => {
    const id = seedModel();
    const err = Object.assign(new Error('API error 404: this model is no longer available'), { status: 404 });
    const oneRequest = {};

    for (let i = 0; i < 4; i++) {
      expect(noteModelRetirementSignal(routeFor(id), err, oneRequest)).toBe(false);
    }
    expect(isRoutable(id)).toBe(true);
  });

  it('never touches user-added models (they are not catalog state)', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
      VALUES ('custom', 'eol-test-custom', 'Custom EOL', 50, 50, 1, 'user')
      ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET enabled = 1
    `).run();
    const row = db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = 'eol-test-custom'")
      .get() as { id: number };
    db.prepare(`
      INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 998, 1)
      ON CONFLICT(model_db_id) DO UPDATE SET enabled = 1
    `).run(row.id);

    expect(noteModelRetirementSignal(
      { modelDbId: row.id, platform: 'custom', modelId: 'eol-test-custom' },
      NVIDIA_EOL,
      {},
    )).toBe(false);
    expect(isRoutable(row.id)).toBe(true);
  });
});

describe('catalog sync vs. upstream retirement (#634)', () => {
  function catalogWith(modelId: string, enabled: boolean) {
    return {
      version: '2099.01.01',
      generatedAt: new Date().toISOString(),
      tier: 'live' as const,
      models: [{
        platform: PLATFORM,
        modelId,
        displayName: 'EOL Test',
        intelligenceRank: 50,
        speedRank: 50,
        sizeLabel: 'Medium',
        limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
        monthlyTokenBudget: '~1M',
        contextWindow: 8192,
        enabled,
        supportsVision: false,
        supportsTools: true,
      }],
      quirks: [],
    } as unknown as Parameters<typeof applyCatalog>[1];
  }

  it('re-enables a corroborated probable 404 when a later catalog still lists it', () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-test-relisted');
    const err = Object.assign(new Error('API error 404: this model is no longer available'), { status: 404 });
    noteModelRetirementSignal(routeFor(id, 'eol-test-relisted'), err, {});
    noteModelRetirementSignal(routeFor(id, 'eol-test-relisted'), err, {});
    expect(isRoutable(id)).toBe(false);

    applyCatalog(getDb(), catalogWith('eol-test-relisted', true));

    expect(isRoutable(id)).toBe(true);
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-test-relisted')).toBeUndefined();
    expect(getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(PLATFORM, 'eol-test-relisted')).toBeDefined();
  });

  it('does not resurrect a permanently paywalled model from the catalog', () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-test-paywalled-relisted');
    noteModelRetirementSignal(routeFor(id, 'eol-test-paywalled-relisted'), FREE_PLAN_ENDED, {});
    expect(getDb().prepare('SELECT id FROM models WHERE id = ?').get(id)).toBeUndefined();

    applyCatalog(getDb(), catalogWith('eol-test-paywalled-relisted', true));

    expect(getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(PLATFORM, 'eol-test-paywalled-relisted')).toBeUndefined();
  });

  it('still deletes models the USER tombstoned (unchanged behavior)', () => {
    seedModel('eol-test-user-deleted');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-test-user-deleted');
    applyCatalog(getDb(), catalogWith('eol-test-user-deleted', true));
    expect(getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(PLATFORM, 'eol-test-user-deleted')).toBeUndefined();
  });
});
