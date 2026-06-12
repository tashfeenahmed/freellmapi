import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import { getDb, initDb } from '../../db/index.js';
import * as crypto from '../../lib/crypto.js';

// Mock ratelimit to control quota availability
vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(),
    canUseTokens: vi.fn(),
    isOnCooldown: vi.fn(() => false),
  };
});

// Mock crypto to avoid IV errors
vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return {
    ...actual,
    decrypt: vi.fn(() => 'mocked-api-key'),
  };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  if (ORIGINAL_DEV_MODE === undefined) {
    delete process.env.DEV_MODE;
  } else {
    process.env.DEV_MODE = ORIGINAL_DEV_MODE;
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

describe('Routing Key Exhaustion', () => {
  beforeEach(() => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    initDb(':memory:');
    // This suite asserts deterministic key/model fallback mechanics, which are
    // strategy-independent — pin the legacy priority order so the bandit's
    // score-based reordering (now the default) doesn't pick seeded catalog
    // models that share the 'google' platform.
    setRoutingStrategy('priority');
    const db = getDb();
    
    // Clear seeded DB data to isolate this test's routing logic
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    db.prepare("DELETE FROM fallback_config").run();
    db.prepare("DELETE FROM profile_models").run();
    db.prepare("DELETE FROM models").run();

    // Setup: 2 models (Pro and Flash)
    // Pro is higher priority (priority 1), Flash is lower (priority 2)
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-1.5-pro', 'Pro', 1, 1, 1)").run();
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-1.5-flash', 'Flash', 2, 2, 1)").run();
    
    const proId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;
    const flashId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-flash'").get().id;
    
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(proId);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(flashId);
    
    // Setup: 2 keys for Google
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key A', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key B', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('should skip exhausted Key B and use functional Key A for the same high-priority model', () => {
    const db = getDb();
    const keys = db.prepare("SELECT id, label FROM api_keys").all();
    const keyA = keys.find(k => k.label === 'Key A');
    const keyB = keys.find(k => k.label === 'Key B');

    // Mock behavior:
    // Key B is exhausted (returns false for canMakeRequest)
    // Key A is functional (returns true)
    (ratelimit.canMakeRequest as any).mockImplementation((platform, modelId, keyId) => {
      if (keyId === keyB.id) return false;
      if (keyId === keyA.id) return true;
      return true;
    });
    (ratelimit.canUseTokens as any).mockReturnValue(true);

    // Act: Route request
    const result = routeRequest(100);

    // Assert: It should have picked the Pro model despite Key B being exhausted
    expect(result.modelId).toBe('gemini-1.5-pro');
    expect(result.keyId).toBe(keyA.id);
    expect(ratelimit.canMakeRequest).toHaveBeenCalled();
  });

  it('should throw 429 when every key on every model is exhausted', () => {
    (ratelimit.canMakeRequest as any).mockReturnValue(false);
    expect(() => routeRequest(100)).toThrow(/All models exhausted/);
  });

  it('should fall back to Flash when Pro is exhausted but Flash has quota', () => {
    (ratelimit.canMakeRequest as any).mockImplementation((_platform: string, modelId: string) => {
      if (modelId === 'gemini-1.5-pro') return false;
      if (modelId === 'gemini-1.5-flash') return true;
      return true;
    });
    (ratelimit.canUseTokens as any).mockReturnValue(true);

    const result = routeRequest(100);
    expect(result.modelId).toBe('gemini-1.5-flash');
  });

  // 404 model-removed handling: a dead model is skipped ENTIRELY for the rest
  // of the request instead of burning one fallback attempt per key on the same
  // dead route. (PR #111, credits @barbotkonv.)
  describe('skipModels (model-level 404 skip)', () => {
    it('skips every key of a skipped model and routes to the next model', () => {
      const db = getDb();
      const proId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;

      // Both keys have quota — without skipModels, Pro would be chosen.
      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      const result = routeRequest(100, undefined, undefined, false, false, new Set([proId]));
      expect(result.modelId).toBe('gemini-1.5-flash');
    });

    it('throws when every model is in skipModels', () => {
      const db = getDb();
      const ids = db.prepare('SELECT id FROM models WHERE enabled = 1').all().map((r: any) => r.id);

      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      expect(() => routeRequest(100, undefined, undefined, false, false, new Set(ids))).toThrow();
    });

    it('overrides a sticky/preferred model that has been skipped', () => {
      const db = getDb();
      const proId = db.prepare("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;

      (ratelimit.canMakeRequest as any).mockReturnValue(true);
      (ratelimit.canUseTokens as any).mockReturnValue(true);

      // Sticky session prefers Pro, but Pro 404ed earlier in this request.
      const result = routeRequest(100, undefined, proId, false, false, new Set([proId]));
      expect(result.modelId).toBe('gemini-1.5-flash');
    });
  });
});
