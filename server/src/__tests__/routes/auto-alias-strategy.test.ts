import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resolveRoutingChain, setRoutingStrategy, refreshStatsCache } from '../../services/router.js';

// #1628: `auto:<axis>` promises per-request ordering ("add a suffix to steer a
// single request instead — no dashboard changes needed", docs/en/api/01-rest-api.md).
// routeRequest re-sorts every chain under the GLOBAL strategy, so the alias's
// axis was discarded and `auto:fast` served the smart/slow model whenever the
// operator sat on Smartest/Balanced. The alias must win for that request only:
// plain `auto` keeps following the global strategy.

let app: Express;

function addKey(platform: string): void {
  const secret = encrypt(`${platform}-alias-strategy-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'alias-strategy', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

// `smart-model` is the best intelligence / measured slow; `fast-model` is the
// reverse. Intelligence comes from the catalog columns, speed from request
// history — the same two inputs the presets weigh.
function addModel(modelId: string, intelligenceRank: number): void {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools
    )
    VALUES ('groq', ?, ?, ?, 1, 'Small', NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(modelId, `Alias Strategy ${modelId}`, intelligenceRank);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, intelligenceRank);
  // The active chain lives in profile_models when a profile is active, so the
  // plain-auto control below walks the same two models.
  const profile = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (profile) {
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
      .run(Number(profile.value), id, intelligenceRank);
  }
}

function addHistory(modelId: string, successes: number, outTokens: number, latencyMs: number): void {
  const ins = getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES ('groq', ?, 1, 'success', 0, ?, ?, NULL, 100)
  `);
  for (let i = 0; i < successes; i++) ins.run(modelId, outTokens, latencyMs);
}

function mockUpstream() {
  const origFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const u = typeof url === 'string' ? url : url.toString();
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

async function chat(model: string): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getUnifiedApiKey()}`,
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  server.close();
  const row = getDb().prepare('SELECT model_id FROM requests ORDER BY id DESC LIMIT 1')
    .get() as { model_id: string } | undefined;
  return row?.model_id ?? '';
}

describe('auto:<axis> steers the request (#1628)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    getDb().exec('DELETE FROM api_keys; DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM models; DELETE FROM requests;');
    addKey('groq');
    addModel('smart-model', 1);
    addModel('fast-model', 90);
    // Measured speed: fast-model produces ~13 tok/ms, smart-model 0.01 tok/ms.
    addHistory('smart-model', 30, 50, 5000);
    addHistory('fast-model', 30, 4000, 300);
    mockUpstream();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps each global axis to its routing preset', () => {
    expect(resolveRoutingChain('auto:smart').strategyOverride).toBe('smartest');
    expect(resolveRoutingChain('auto:fast').strategyOverride).toBe('fastest');
    expect(resolveRoutingChain('auto:reliable').strategyOverride).toBe('reliable');
    // Budget-leaning alias keeps the balanced blend (everything here is free).
    expect(resolveRoutingChain('auto:cheap').strategyOverride).toBe('balanced');
    // Plain auto and named chains are the operator's strategy to choose.
    expect(resolveRoutingChain('auto').strategyOverride).toBeUndefined();
  });

  it('serves the fast model for auto:fast even under the Smartest strategy', async () => {
    setRoutingStrategy('smartest');
    refreshStatsCache(getDb(), true);
    expect(await chat('auto:fast')).toBe('fast-model');
  });

  it('serves the smart model for auto:smart even under the Fastest strategy', async () => {
    setRoutingStrategy('fastest');
    refreshStatsCache(getDb(), true);
    expect(await chat('auto:smart')).toBe('smart-model');
  });

  it('keeps plain auto on the global strategy', async () => {
    setRoutingStrategy('smartest');
    refreshStatsCache(getDb(), true);
    expect(await chat('auto')).toBe('smart-model');
  });

  it('steers under Manual too, where the global strategy is the chain order', async () => {
    setRoutingStrategy('priority');
    refreshStatsCache(getDb(), true);
    expect(await chat('auto:smart')).toBe('smart-model');
    expect(await chat('auto:fast')).toBe('fast-model');
  });
});
