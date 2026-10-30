import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { encrypt } from '../../lib/crypto.js';
import { resolveRoutingChain, routeRequest } from '../../services/router.js';

// Per-chain routing preset. routing_strategy used to be a single global
// setting, so every chain was ranked by the same preset even though a chain
// already isolates its own candidate set. profiles.routing_strategy lets a
// chain carry its own preset; NULL inherits the global one, so an install that
// never touches the column keeps the old behaviour exactly.

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
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

/**
 * A healthy provider key. routeRequest drops any model whose platform has no
 * routable key, so the ranking test needs one before it can score anything.
 */
function addKey(platform = 'groq'): number {
  const db = getDb();
  const enc = encrypt('test-key-for-routing');
  const inserted = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, platform + ' test key', enc.encrypted, enc.iv, enc.authTag);
  return Number(inserted.lastInsertRowid);
}

/** A catalog row the router can rank. Lower intelligence_rank = smarter. */
function addModel(modelId: string, intelligenceRank: number, sizeLabel = 'Large'): number {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools
    )
    VALUES ('groq', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(modelId, modelId, intelligenceRank, intelligenceRank, sizeLabel);
  return Number(inserted.lastInsertRowid);
}

function addToChain(profileId: number, modelDbId: number, priority: number): void {
  getDb().prepare(
    'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)',
  ).run(profileId, modelDbId, priority);
}

function setGlobalStrategy(strategy: string): void {
  getDb().prepare(
    "INSERT INTO settings (key, value) VALUES ('routing_strategy', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(strategy);
}

describe('per-chain routing strategy', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('stores and clears a preset through the profiles API', async () => {
    const chain = (await request('POST', '/api/profiles', { name: 'ingest', empty: true })).body;

    const set = await request('PUT', `/api/profiles/${chain.id}`, { routing_strategy: 'reliable' });
    expect(set.status).toBe(200);
    expect(set.body.routing_strategy).toBe('reliable');

    // GET has to surface it, or the dashboard cannot show which preset is on.
    const listed = (await request('GET', '/api/profiles')).body as { id: number; routing_strategy: string | null }[];
    expect(listed.find(p => p.id === chain.id)?.routing_strategy).toBe('reliable');

    // NULL means "inherit the global strategy" — a distinct state from unset.
    const cleared = await request('PUT', `/api/profiles/${chain.id}`, { routing_strategy: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.routing_strategy).toBeNull();
  });

  it('rejects a preset that is not a routing strategy', async () => {
    const chain = (await request('POST', '/api/profiles', { name: 'bogus', empty: true })).body;
    const bad = await request('PUT', `/api/profiles/${chain.id}`, { routing_strategy: 'not-a-strategy' });
    expect(bad.status).toBe(400);
  });

  it('carries the preset on the chain rows the router reads', async () => {
    const chain = (await request('POST', '/api/profiles', { name: 'carry', empty: true })).body;
    const modelId = addModel('carry-model', 1);
    addToChain(chain.id, modelId, 1);
    await request('PUT', `/api/profiles/${chain.id}`, { routing_strategy: 'smartest' });

    const rows = resolveRoutingChain('auto:carry').chain;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].profile_strategy).toBe('smartest');
  });

  it('leaves the preset absent when the chain never set one', async () => {
    const chain = (await request('POST', '/api/profiles', { name: 'plain', empty: true })).body;
    addToChain(chain.id, addModel('plain-model', 1), 1);

    const rows = resolveRoutingChain('auto:plain').chain;
    expect(rows[0].profile_strategy ?? null).toBeNull();
  });

  it('ranks by the chain preset and lets it outrank the global strategy', () => {
    // `first` sits at the head of the chain but is the dullest model in it;
    // `bright` sits second and is the smartest. Manual order and Smartest
    // therefore disagree, which is what makes the preset observable: whichever
    // one wins tells us which preset actually ranked the chain.
    const chain = getDb().prepare(
      "INSERT INTO profiles (name, type, sort_order) VALUES ('ranked', 'custom', 1) RETURNING id",
    ).get() as { id: number };

    addKey();
    const firstId = addModel('chain-first-model', 900, 'Small');
    const brightId = addModel('chain-bright-model', 1, 'Large');
    addToChain(chain.id, firstId, 1);
    addToChain(chain.id, brightId, 2);

    const route = (): number =>
      routeRequest(1000, undefined, undefined, false, false, undefined,
        resolveRoutingChain('auto:ranked').chain).modelDbId;

    const setChain = (preset: string | null) =>
      getDb().prepare('UPDATE profiles SET routing_strategy = ? WHERE id = ?').run(preset, chain.id);

    /** Most-picked model over N draws — the bandit samples on every call. */
    const lean = (draws = 25): number => {
      const counts = new Map<number, number>();
      for (let i = 0; i < draws; i++) {
        const id = route();
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };

    // Manual order is deterministic: it follows profile_models.priority and
    // ignores scores entirely, so this also proves the chain's preset is read
    // even though the global strategy says smartest.
    setGlobalStrategy('smartest');
    setChain('priority');
    expect(route()).toBe(firstId);

    // The opposite way round: the chain asks for Smartest while the global
    // strategy says manual, so the smart model must win on its own merits.
    setGlobalStrategy('priority');
    setChain('smartest');
    expect(lean()).toBe(brightId);

    // NULL inherits: with no chain preset the global manual order applies
    // again, so the chain head wins without the column being touched.
    setChain(null);
    expect(route()).toBe(firstId);
  });
});
