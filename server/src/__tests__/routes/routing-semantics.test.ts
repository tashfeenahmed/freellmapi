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
} from '../../services/router.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: any) {
  const server = app.listen(0);
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

function addKey(platform: string): void {
  const secret = encrypt(`${platform}-routing-test-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'routing-test', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

function addSyntheticModel(modelId: string, priority: number, enabled = true): number {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools
    )
    VALUES ('groq', ?, ?, ?, ?, 'Small', NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(modelId, `Routing Test ${modelId}`, priority, priority);
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
