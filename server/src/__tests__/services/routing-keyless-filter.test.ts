import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';
import { routingExhaustionBody } from '../../lib/fallback-loop.js';

// A model whose PLATFORM has no enabled+healthy key can never produce a route:
// selectKeyForModel's first query comes back empty for it, every request. So it
// is dropped before the walk instead of burning an iteration and padding the
// exhaustion diagnostic with a constant that says nothing about why THIS
// request failed. Live case: the clean tier reported "37 routes checked
// (... 14 no usable key configured ...)" when only 22 rows were ever candidates.

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

function insertModel(platform: string, modelId: string, priority: number): number {
  const db = getDb();
  db.prepare(
    "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES (?, ?, ?, 1, 1, 1)"
  ).run(platform, modelId, modelId);
  const id = (db.prepare('SELECT id FROM models WHERE model_id = ?').get(modelId) as any).id;
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  return id;
}

function routeError(): any {
  try {
    routeRequest(100);
  } catch (e) {
    return e;
  }
  throw new Error('expected routeRequest to throw');
}

describe('keyless-platform prefilter', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    setRoutingStrategy('priority');
    const db = getDb();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();

    // google is keyed; cohere and mistral are in the catalog with no key at all.
    insertModel('google', 'gemini-1.5-pro', 1);
    insertModel('cohere', 'command-r', 2);
    insertModel('mistral', 'mistral-small', 3);
    db.prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key A', 'enc', 'iv', 'tag', 'healthy', 1)"
    ).run();

    vi.clearAllMocks();
    (ratelimit.canMakeRequest as any).mockReturnValue(true);
    (ratelimit.canUseTokens as any).mockReturnValue(true);
    (ratelimit.isOnCooldown as any).mockReturnValue(false);
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE;
    else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('still routes to the keyed model (no behavior change on the happy path)', () => {
    expect(routeRequest(100).modelId).toBe('gemini-1.5-pro');
  });

  // The absent diag line IS the proof the row was never walked: a keyless model
  // that reaches selectKeyForModel always pushes "no enabled+healthy key for
  // platform" before returning null.
  it('keeps keyless models out of the walk, the diagnostics, and the route count', () => {
    (ratelimit.canMakeRequest as any).mockReturnValue(false); // exhaust the keyed model

    const err = routeError();
    // Walked rows + exactly ONE aggregate line for the two keyless platforms.
    expect(err.diagnostics).toHaveLength(2);
    expect(err.diagnostics[0]).toContain('google/gemini-1.5-pro');
    expect(err.diagnostics[1]).toBe(
      '2 model(s) skipped: no enabled+healthy key for platform (cohere, mistral)'
    );
    expect(err.message).toContain('1 route checked');
    expect(err.message).toContain('2 models skipped: no key configured for their platform.');
    expect(err.message).not.toContain('no usable key configured');
  });

  it('exempts an explicitly pinned model so it reports against its own label', () => {
    const db = getDb();
    const cohereId = (db.prepare("SELECT id FROM models WHERE model_id = 'command-r'").get() as any).id;

    let err: any;
    try {
      routeRequest(100, undefined, cohereId);
    } catch (e) {
      err = e;
    }
    // The pin is walked, fails honestly, and the keyed google model is still
    // reached as fallback - so this must NOT throw.
    expect(err).toBeUndefined();

    (ratelimit.canMakeRequest as any).mockReturnValue(false);
    try {
      routeRequest(100, undefined, cohereId);
    } catch (e) {
      err = e;
    }
    expect(err.diagnostics.some((d: string) => d.includes('cohere/command-r'))).toBe(true);
    expect(err.message).toContain('1 no usable key configured');
    // mistral stays filtered; only cohere was exempted.
    expect(err.message).toContain('1 model skipped: no key configured for their platform.');
  });

  it('reports the skip count even when every candidate is keyless', () => {
    getDb().prepare('DELETE FROM api_keys').run();
    const err = routeError();
    expect(err.message).toContain('3 models skipped: no key configured for their platform.');
    // A fully-unconfigured pool must still classify as config (503), which
    // routingExhaustionBody reads off the diagnostics, not the message.
    expect(err.diagnostics).toEqual([
      '3 model(s) skipped: no enabled+healthy key for platform (cohere, google, mistral)',
    ]);
    expect(routingExhaustionBody(err).status).toBe(503);
  });
});
