import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  resolveModelGroupCandidates,
  resolveRoutingChain,
  routeRequest,
  setRoutingStrategy,
  setKeySelectionStrategy,
} from '../../services/router.js';
import { recordQuotaObservation } from '../../services/provider-quota.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function activeProfileId(): number {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string };
  return Number(row.value);
}

function addKey(platform: string, label = 'routing-test'): number {
  const secret = encrypt(`${platform}-${label}-routing-test-key`);
  const inserted = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, label, secret.encrypted, secret.iv, secret.authTag);
  return Number(inserted.lastInsertRowid);
}

// A key on a custom endpoint, identified by its base_url (the endpoint IS the
// url; several credentials may share it — see services/custom-endpoint.ts).
function addCustomKey(baseUrl: string, label: string): number {
  const secret = encrypt(`${label}-custom-secret`);
  const inserted = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', ?, ?, ?, ?, 'healthy', 1, ?)
  `).run(label, secret.encrypted, secret.iv, secret.authTag, baseUrl);
  return Number(inserted.lastInsertRowid);
}

/** Wipe the chain so a test routes over exactly the models it seeds. */
function clearChain(): void {
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
}

/** A key's observed quota, as the provider would have reported it in headers. */
function observeQuota(platform: string, keyId: number, pool: string, remaining: number, limit = 1000): void {
  recordQuotaObservation({
    platform: platform as any,
    keyId,
    quotaPoolKey: pool,
    metric: 'requests',
    limit,
    remaining,
    source: 'header',
  });
}

function addSyntheticModel(
  modelId: string,
  priority: number,
  enabled = true,
  platform = 'groq',
  keyId: number | null = null,
): number {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools, key_id
    )
    VALUES (?, ?, ?, ?, ?, 'Small', NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1, ?)
  `).run(platform, modelId, `Routing Test ${modelId}`, priority, priority, keyId);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)').run(id, priority, enabled ? 1 : 0);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)')
    .run(activeProfileId(), id, priority, enabled ? 1 : 0);
  return id;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  setRoutingStrategy('priority');
  getDb().prepare('DELETE FROM api_keys').run();
});

describe('routing semantics', () => {
  it('Models page fallback edits update the active profile chain the router uses', async () => {
    addKey('groq');
    addKey('google');

    const db = getDb();
    const groq = db.prepare(`
      SELECT m.id
        FROM profile_models pm
        JOIN models m ON m.id = pm.model_db_id
       WHERE pm.profile_id = ? AND m.platform = 'groq' AND m.enabled = 1
       ORDER BY pm.priority
       LIMIT 1
    `).get(activeProfileId()) as { id: number };
    const google = db.prepare(`
      SELECT m.id
        FROM profile_models pm
        JOIN models m ON m.id = pm.model_db_id
       WHERE pm.profile_id = ? AND m.platform = 'google' AND m.enabled = 1
       ORDER BY pm.priority
       LIMIT 1
    `).get(activeProfileId()) as { id: number };

    const original = await request('GET', '/api/fallback');
    expect(original.status).toBe(200);
    const update = original.body.map((row: any, index: number) => ({
      modelDbId: row.modelDbId,
      priority: row.modelDbId === groq.id ? 1 : row.modelDbId === google.id ? 2 : index + 100,
      enabled: true,
    }));
    const saved = await request('PUT', '/api/fallback', update);
    expect(saved.status).toBe(200);

    const profileRow = db.prepare('SELECT priority FROM profile_models WHERE profile_id = ? AND model_db_id = ?')
      .get(activeProfileId(), groq.id) as { priority: number };
    expect(profileRow.priority).toBe(1);
    expect(routeRequest(100).modelDbId).toBe(groq.id);
  });

  it('custom models added after profile seeding are appended to the active profile and auto-routable', async () => {
    const created = await request('POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'profile-visible-custom-model',
    });
    expect(created.status).toBe(201);

    const profileRow = getDb().prepare('SELECT enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?')
      .get(activeProfileId(), created.body.modelDbId) as { enabled: number } | undefined;
    expect(profileRow?.enabled).toBe(1);

    const routed = routeRequest(100);
    expect(routed.platform).toBe('custom');
    expect(routed.modelId).toBe('profile-visible-custom-model');
  });

  it('auto routing skips chain-disabled models even when the chain is prefetched', () => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM models').run();
    addKey('groq');

    const disabledId = addSyntheticModel('disabled-for-auto', 1, false);
    const enabledId = addSyntheticModel('enabled-for-auto', 2, true);

    const resolved = resolveRoutingChain('auto');
    const routed = routeRequest(100, undefined, undefined, false, false, undefined, resolved.chain);
    expect(routed.modelDbId).toBe(enabledId);
    expect(routed.modelDbId).not.toBe(disabledId);
  });

  it('refuses model:"auto" on an empty active chain instead of routing the catalog (#1021)', () => {
    const db = getDb();
    addKey('groq');
    // The chain the operator is on holds nothing — a chain created with
    // "start empty", or one pruned by hand. fallback_config still lists the
    // whole seeded catalog, which is exactly what must NOT be routed over.
    db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(activeProfileId());
    expect((db.prepare('SELECT COUNT(*) AS n FROM fallback_config').get() as { n: number }).n)
      .toBeGreaterThan(0);

    let thrown: any;
    try { resolveRoutingChain('auto'); } catch (err) { thrown = err; }
    expect(thrown).toBeDefined();
    expect(thrown.status).toBe(400);
    expect(thrown.message).toMatch(/no enabled models/i);
    // The named form of the same chain already behaved this way; both agree now.
    expect(() => resolveRoutingChain('auto:default')).toThrow(/no enabled models/i);
  });

  it('routes an active chain whose models are all switched off nowhere either', () => {
    const db = getDb();
    addKey('groq');
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE profile_id = ?').run(activeProfileId());

    expect(() => resolveRoutingChain('auto')).toThrow(/no enabled models/i);
  });

  it('explicit named routing can still use a model disabled only for auto routing', () => {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM models').run();
    addKey('groq');

    const disabledId = addSyntheticModel('direct-only-model', 1, false);
    addSyntheticModel('auto-model', 2, true);

    const groupChain = resolveModelGroupCandidates([disabledId]);
    expect(groupChain.map(row => row.model_db_id)).toEqual([disabledId]);

    const routed = routeRequest(100, undefined, undefined, false, false, undefined, groupChain);
    expect(routed.modelDbId).toBe(disabledId);
    expect(routed.modelId).toBe('direct-only-model');
  });
});

// ── #919: remaining-quota key selection ─────────────────────────────────────
// A separate setting from the routing strategy: the strategy ranks MODELS, this
// picks between several keys of one platform. 'least-remaining' ranks them by
// how much of their observed quota is left and tries the roomiest first, so the
// key nearest its cap is held in reserve instead of being the next to 429.
describe('key selection by remaining quota (#919)', () => {
  // cerebras meters each key against its own budget ('cerebras::shared'), which
  // is what makes "which key has more left" a question with an answer.
  const CEREBRAS_POOL = 'cerebras::shared';

  /** Two cerebras keys — the drained one FIRST, so rowid order (and the
   *  round-robin cursor that starts on it) would pick exactly the wrong key.
   *  The model id is per-test because the rotation cursor is keyed on it and
   *  outlives the in-memory DB. */
  function seedTwoKeys(modelId: string): { drained: number; roomy: number } {
    clearChain();
    const drained = addKey('cerebras', 'drained');
    const roomy = addKey('cerebras', 'roomy');
    observeQuota('cerebras', drained, CEREBRAS_POOL, 20);
    observeQuota('cerebras', roomy, CEREBRAS_POOL, 950);
    addSyntheticModel(modelId, 1, true, 'cerebras');
    return { drained, roomy };
  }

  it('routes to the key with the MOST quota left, even though it was added last', () => {
    const { drained, roomy } = seedTwoKeys('roomiest-key-wins');
    setKeySelectionStrategy('least-remaining');

    const routed = routeRequest(100);
    routed.release?.();
    expect(routed.platform).toBe('cerebras');
    expect(routed.keyId).toBe(roomy);
    expect(routed.keyId).not.toBe(drained);
  });

  it("leaves the rotation alone under the default 'auto' selection", () => {
    const { drained } = seedTwoKeys('auto-keeps-rotation');
    // Same data, setting untouched: the round-robin cursor still starts on the
    // first key, which is what proves the reordering above came from the knob.
    const routed = routeRequest(100);
    routed.release?.();
    expect(routed.keyId).toBe(drained);
  });

  it('keeps the round-robin rotation when no key has a quota observation', () => {
    clearChain();
    const first = addKey('cerebras', 'first');
    const second = addKey('cerebras', 'second');
    addSyntheticModel('unobserved-model', 1, true, 'cerebras');
    setKeySelectionStrategy('least-remaining');

    const picks: number[] = [];
    for (let i = 0; i < 3; i++) {
      const routed = routeRequest(100);
      routed.release?.();
      picks.push(routed.keyId);
    }
    // No signal → no ranking: the legacy rotation is untouched.
    expect(picks).toEqual([first, second, first]);
  });

  it('does not reorder keys on an account-scoped quota pool', () => {
    clearChain();
    // groq pools every key of the account into one budget ('groq::account'), so
    // per-key headroom is the same number for all of them and reordering would
    // only churn the rotation.
    const firstKey = addKey('groq', 'first');
    const secondKey = addKey('groq', 'second');
    observeQuota('groq', firstKey, 'groq::account', 10);
    observeQuota('groq', secondKey, 'groq::account', 990);
    addSyntheticModel('account-pool-model', 1, true, 'groq');
    setKeySelectionStrategy('least-remaining');

    const routed = routeRequest(100);
    routed.release?.();
    expect(routed.keyId).toBe(firstKey);
  });

  it('still confines a custom model to its own endpoint\'s keys', () => {
    clearChain();
    const endpointA = 'http://127.0.0.1:11434/v1';
    const endpointB = 'http://127.0.0.1:8080/v1';
    const aDrained = addCustomKey(endpointA, 'endpoint-a-drained');
    const aRoomy = addCustomKey(endpointA, 'endpoint-a-roomy');
    // The roomiest key on the platform belongs to a DIFFERENT endpoint, so a
    // sort that forgot the endpoint filter would hand this model B's key.
    const bRoomiest = addCustomKey(endpointB, 'endpoint-b');
    observeQuota('custom', aDrained, 'custom::endpoint-a-model', 30);
    observeQuota('custom', aRoomy, 'custom::endpoint-a-model', 600);
    observeQuota('custom', bRoomiest, 'custom::endpoint-a-model', 999);
    addSyntheticModel('endpoint-a-model', 1, true, 'custom', aDrained);
    setKeySelectionStrategy('least-remaining');

    const routed = routeRequest(100);
    routed.release?.();
    expect(routed.platform).toBe('custom');
    expect(routed.keyId).toBe(aRoomy);
    expect(routed.keyId).not.toBe(bRoomiest);
  });

  it('round-trips the setting through GET/PUT /api/fallback/routing', async () => {
    const before = await request('GET', '/api/fallback/routing');
    expect(before.status).toBe(200);
    expect(before.body.keySelectionStrategy).toBe('auto');

    const put = await request('PUT', '/api/fallback/routing', {
      strategy: 'balanced',
      keySelectionStrategy: 'least-remaining',
    });
    expect(put.status).toBe(200);
    expect(put.body.keySelectionStrategy).toBe('least-remaining');

    const after = await request('GET', '/api/fallback/routing');
    expect(after.body.keySelectionStrategy).toBe('least-remaining');
    // Independent of the model strategy: switching strategy leaves it alone.
    const switched = await request('PUT', '/api/fallback/routing', { strategy: 'fastest' });
    expect(switched.body.keySelectionStrategy).toBe('least-remaining');
    expect(switched.body.strategy).toBe('fastest');

    const rejected = await request('PUT', '/api/fallback/routing', {
      strategy: 'balanced',
      keySelectionStrategy: 'quota-weighted',
    });
    expect(rejected.status).toBe(400);
  });
});
