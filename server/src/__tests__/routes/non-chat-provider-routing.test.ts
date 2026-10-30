import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest } from '../../services/router.js';
import { getProvider } from '../../providers/index.js';

function addKey(platform: string): number {
  const secret = encrypt(`${platform}-non-chat-routing-key`);
  const inserted = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'non-chat-routing', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
  return Number(inserted.lastInsertRowid);
}

function clearChain(): void {
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
}

function mockUpstream() {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
    // Return a plausible 200 for any upstream to avoid test flake; the router
    // should never reach the upstream for a non-chat provider because the guard
    // returns null before key selection.
    if (u.includes('api.groq.com')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({
          id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: 'default',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      } as any;
    }
    return origFetch(url, init);
  });
}

describe('Router guard for non-chat providers (#1741)', () => {
  beforeEach(async () => {
    initDb(':memory:');
    createApp();
    clearChain();
    mockUpstream();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips legacy tavily chat row in fallback chain', async () => {
    // Sanity: the provider exists but declares supportsChat === false
    const p = getProvider('tavily');
    expect(p).toBeDefined();
    expect(p!.supportsChat).toBe(false);

    // Seed a legacy tavily chat row + key + fallback chain entry
    const tavilyKey = addKey('tavily');
    const tavilyId = Number(getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools, key_id, source)
      VALUES ('tavily', 'legacy-search', 'Legacy Tavily', 1, 1, 'Small',
        NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1, ?, 'user')
    `).run(tavilyKey).lastInsertRowid);

    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)')
      .run(tavilyId);
    const profileId = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
    if (profileId) {
      getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)')
        .run(Number(profileId.value), tavilyId);
    }

    // Also seed a real chat model (groq) with a key so the chain has a valid target
    const groqKey = addKey('groq');
    const groqId = Number(getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools, key_id, source)
      VALUES ('groq', 'llama-3.1-8b-instant', 'Groq Llama', 2, 2, 'Small',
        NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1, ?, 'user')
    `).run(groqKey).lastInsertRowid);

    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)')
      .run(groqId);
    if (profileId) {
      getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 2, 1)')
        .run(Number(profileId.value), groqId);
    }

    // routeRequest should skip tavily entirely and land on groq
    const route = routeRequest(1000);
    expect(route).not.toBeNull();
    expect(route!.modelDbId).toBe(groqId);
  });

  it('skips legacy speechify and beatapi chat rows', async () => {
    for (const platform of ['speechify', 'beatapi']) {
      clearChain();

      const p = getProvider(platform);
      expect(p).toBeDefined();
      expect(p!.supportsChat).toBe(false);

      const keyId = addKey(platform);
      const modelId = Number(getDb().prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
          rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
          context_window, enabled, supports_vision, supports_tools, key_id, source)
        VALUES (?, 'legacy-tts', 'Legacy TTS', 1, 1, 'Small',
          NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1, ?, 'user')
      `).run(platform, keyId).lastInsertRowid);

      getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)')
        .run(modelId);
      const profileId = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
      if (profileId) {
        getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)')
          .run(Number(profileId.value), modelId);
      }

      // No other model in chain -> routing exhausts (the only candidate is
      // refused by the guard) rather than attempting a doomed chat call.
      expect(() => routeRequest(1000)).toThrow(/All models exhausted/);
    }
  });

  it('still routes to a custom endpoint whose adapter supports chat', async () => {
    // Custom endpoint on a non-chat platform must still work for chat if the
    // remote endpoint speaks chat (the gate only applies to built-in adapters).
    const customKey = addKey('custom');
    // Override the key's base_url to a chat-speaking endpoint
    getDb().prepare(`
      UPDATE api_keys SET base_url = 'http://127.0.0.1:9099/v1' WHERE id = ?
    `).run(customKey);

    const modelId = Number(getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
        context_window, enabled, supports_vision, supports_tools, key_id, source, endpoint_scope)
      VALUES ('custom', 'custom-chat', 'Custom Chat', 1, 1, 'Small',
        NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1, ?, 'user', 'http://127.0.0.1:9099/v1')
    `).run(customKey).lastInsertRowid);

    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)')
      .run(modelId);
    const profileId = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
    if (profileId) {
      getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)')
        .run(Number(profileId.value), modelId);
    }

    const route = routeRequest(1000);
    expect(route).not.toBeNull();
    expect(route!.modelDbId).toBe(modelId);
  });
});