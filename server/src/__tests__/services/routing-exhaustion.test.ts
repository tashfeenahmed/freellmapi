import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { routeRequest } from '../../services/router.js';
import * as ratelimit from '../../services/ratelimit.js';
import * as crypto from '../../lib/crypto.js';
import { getDb, initDb } from '../../db/index.js';

describe('Routing Key Exhaustion', () => {
  let spyCanMakeRequest: MockInstance;
  let spyCanUseTokens: MockInstance;
  let spyIsOnCooldown: MockInstance;
  let spyDecrypt: MockInstance;

  beforeEach(() => {
    initDb(':memory:');
    const db = getDb();

    // Setup: 2 models (Pro and Flash)
    // Pro is higher priority (priority 1), Flash is lower (priority 2)
    db.query("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-1.5-pro', 'Pro', 1, 1, 1)").run();
    db.query("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('google', 'gemini-1.5-flash', 'Flash', 2, 2, 1)").run();

    const proId = db.query("SELECT id FROM models WHERE model_id = 'gemini-1.5-pro'").get().id;
    const flashId = db.query("SELECT id FROM models WHERE model_id = 'gemini-1.5-flash'").get().id;

    db.query("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(proId);
    db.query("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(flashId);

    // Setup: 2 keys for Google
    db.query("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key A', 'enc', 'iv', 'tag', 'healthy', 1)").run();
    db.query("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('google', 'Key B', 'enc', 'iv', 'tag', 'healthy', 1)").run();

    // Set up runtime spies directly on the imported modules
    spyCanMakeRequest = vi.spyOn(ratelimit, 'canMakeRequest');
    spyCanUseTokens = vi.spyOn(ratelimit, 'canUseTokens');
    spyIsOnCooldown = vi.spyOn(ratelimit, 'isOnCooldown').mockReturnValue(false);

    // Catch decryption calls on runtime module execution safely
    spyDecrypt = vi.spyOn(crypto, 'decrypt').mockReturnValue('mocked-api-key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should skip exhausted Key B and use functional Key A for the same high-priority model', () => {
    const db = getDb();
    const keys = db.query("SELECT id, label FROM api_keys").all() as { id: string; label: string }[];
    const keyA = keys.find(k => k.label === 'Key A');
    const keyB = keys.find(k => k.label === 'Key B');

    // Mock behavior:
    // Key B is exhausted (returns false for canMakeRequest)
    // Key A is functional (returns true)
    spyCanMakeRequest.mockImplementation((platform, modelId, keyId) => {
      if (keyId === keyB!.id) return false;
      if (keyId === keyA!.id) return true;
      return true;
    });
    spyCanUseTokens.mockReturnValue(true);

    // Act: Route request
    const result = routeRequest(100);

    // Assert: It should have picked the Pro model despite Key B being exhausted
    expect(result.modelId).toBe('gemini-1.5-pro');
    expect(result.keyId).toBe(keyA!.id);
    expect(spyCanMakeRequest).toHaveBeenCalled();
  });

  it('should throw 429 when every key on every model is exhausted', () => {
    spyCanMakeRequest.mockReturnValue(false);
    expect(() => routeRequest(100)).toThrow(/All models exhausted/);
  });

  it('should fall back to Flash when Pro is exhausted but Flash has quota', () => {
    spyCanMakeRequest.mockImplementation((_platform: string, modelId: string) => {
      if (modelId === 'gemini-1.5-pro') return false;
      if (modelId === 'gemini-1.5-flash') return true;
      return true;
    });
    spyCanUseTokens.mockReturnValue(true);

    const result = routeRequest(100);
    expect(result.modelId).toBe('gemini-1.5-flash');
  });
});
