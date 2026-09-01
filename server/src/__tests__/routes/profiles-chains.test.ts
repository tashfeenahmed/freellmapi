import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { ensureAllModelsInProfiles, ensureModelInProfiles } from '../../services/profile-models.js';

// Named fallback chains you build by hand (#895). Two things have to hold for
// a curated chain to survive: creating one must not dump the whole catalog
// into it, and the catalog-sync backfill must leave it alone afterwards.
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

function chainSize(profileId: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM profile_models WHERE profile_id = ?')
    .get(profileId) as { n: number }).n;
}

/** Enabled catalog models — what GET /api/fallback lists for any chain. */
function catalogSize(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM models WHERE enabled = 1')
    .get() as { n: number }).n;
}

/** The single global table every chain used to be aliased onto (#1021). */
function globalConfig(): { model_db_id: number; priority: number; enabled: number }[] {
  return getDb().prepare(
    'SELECT model_db_id, priority, enabled FROM fallback_config ORDER BY model_db_id',
  ).all() as { model_db_id: number; priority: number; enabled: number }[];
}

function autoInclude(profileId: number): number {
  return (getDb().prepare('SELECT auto_include_new_models AS flag FROM profiles WHERE id = ?')
    .get(profileId) as { flag: number }).flag;
}

// A model that arrives after the chains already exist — what a catalog sync
// produces, and what the backfill would otherwise push into every chain.
function addCatalogModel(modelId: string): number {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
    VALUES ('groq', ?, ?, 500, 500, 'Small', 1)
  `).run(modelId, `Synced ${modelId}`);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 500, 1)').run(id);
  return id;
}

describe('named fallback chains', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('creates an empty chain that holds nothing (#895)', async () => {
    const { status, body } = await request('POST', '/api/profiles', { name: 'hand-built', empty: true });
    expect(status).toBe(201);
    expect(body.name).toBe('hand-built');
    expect(chainSize(body.id)).toBe(0);
    // An empty chain opts out of the backfill by construction — otherwise the
    // next catalog sync would undo the emptiness.
    expect(autoInclude(body.id)).toBe(0);
  });

  it('still copies the catalog when empty is not asked for', async () => {
    const { status, body } = await request('POST', '/api/profiles', { name: 'inherited' });
    expect(status).toBe(201);

    const catalogSize = (getDb().prepare('SELECT COUNT(*) AS n FROM fallback_config').get() as { n: number }).n;
    expect(catalogSize).toBeGreaterThan(0);
    expect(chainSize(body.id)).toBe(catalogSize);
    expect(autoInclude(body.id)).toBe(1);
  });

  it('lets empty win over a source chain to copy from', async () => {
    const source = await request('POST', '/api/profiles', { name: 'source' });
    expect(chainSize(source.body.id)).toBeGreaterThan(0);

    const { status, body } = await request('POST', '/api/profiles', {
      name: 'empty-clone', empty: true, sourceProfileId: source.body.id,
    });
    expect(status).toBe(201);
    expect(chainSize(body.id)).toBe(0);
  });

  it('keeps a curated chain pruned across a catalog backfill (#895)', async () => {
    const curated = (await request('POST', '/api/profiles', { name: 'curated', empty: true })).body;
    const inheriting = (await request('POST', '/api/profiles', { name: 'inheriting' })).body;
    const inheritingBefore = chainSize(inheriting.id);

    addCatalogModel('backfill-arrival');
    ensureAllModelsInProfiles(getDb());

    // The chain that opted in grew by the new model; the curated one did not.
    expect(chainSize(inheriting.id)).toBe(inheritingBefore + 1);
    expect(chainSize(curated.id)).toBe(0);
  });

  it('keeps a curated chain pruned when a single model is registered', async () => {
    const curated = (await request('POST', '/api/profiles', { name: 'curated', empty: true })).body;
    const inheriting = (await request('POST', '/api/profiles', { name: 'inheriting' })).body;
    const inheritingBefore = chainSize(inheriting.id);

    // The per-model path, used when one custom endpoint model is registered.
    const modelDbId = addCatalogModel('single-arrival');
    ensureModelInProfiles(getDb(), modelDbId);

    expect(chainSize(inheriting.id)).toBe(inheritingBefore + 1);
    expect(chainSize(curated.id)).toBe(0);
  });

  it('lets a chain opt out of the backfill after the fact', async () => {
    const chain = (await request('POST', '/api/profiles', { name: 'settled' })).body;
    expect(autoInclude(chain.id)).toBe(1);

    // Prune it by hand, then stop new models from being pushed back in.
    getDb().prepare('DELETE FROM profile_models WHERE profile_id = ?').run(chain.id);
    const updated = await request('PUT', `/api/profiles/${chain.id}`, { auto_include_new_models: false });
    expect(updated.status).toBe(200);
    expect(updated.body.auto_include_new_models).toBe(0);
    expect(autoInclude(chain.id)).toBe(0);

    addCatalogModel('after-opt-out');
    ensureAllModelsInProfiles(getDb());
    expect(chainSize(chain.id)).toBe(0);
  });

  it('shows an empty active chain as the catalog with nothing turned on (#1021)', async () => {
    const empty = (await request('POST', '/api/profiles', { name: 'blank', empty: true })).body;
    expect((await request('POST', '/api/profiles/active', { profileId: empty.id })).status).toBe(200);

    const { status, body } = await request('GET', '/api/fallback');
    expect(status).toBe(200);
    // Every catalog model is listed — an empty chain is an empty set of
    // opt-ins, not an empty page — and not one of them is enabled. Before the
    // fix the zero-row chain fell through to the global table and displayed the
    // whole catalog switched ON.
    expect(body.length).toBe(catalogSize());
    expect(body.every((row: { enabled: boolean }) => row.enabled === false)).toBe(true);
    // Priorities stay monotonic so the table renders in a stable order.
    for (let i = 1; i < body.length; i++) {
      expect(body[i].priority).toBeGreaterThanOrEqual(body[i - 1].priority);
    }
    // Reading the chain never writes to it.
    expect(chainSize(empty.id)).toBe(0);
  });

  it('fills an empty chain on save without touching the global table (#1021)', async () => {
    const chain = (await request('POST', '/api/profiles', { name: 'built', empty: true })).body;
    await request('POST', '/api/profiles/active', { profileId: chain.id });

    const before = globalConfig();
    const listed = (await request('GET', '/api/fallback')).body as { modelDbId: number }[];
    const picked = [listed[0].modelDbId, listed[1].modelDbId];
    const saved = await request('PUT', '/api/fallback', listed.map((row, index) => ({
      modelDbId: row.modelDbId,
      priority: index + 1,
      enabled: picked.includes(row.modelDbId),
    })));
    expect(saved.status).toBe(200);

    // The two picks landed in THIS chain, enabled...
    const enabled = getDb().prepare(
      'SELECT model_db_id FROM profile_models WHERE profile_id = ? AND enabled = 1 ORDER BY priority',
    ).all(chain.id) as { model_db_id: number }[];
    expect(enabled.map(r => r.model_db_id)).toEqual(picked);
    // ...and the global fallback_config every chain used to share is untouched.
    expect(globalConfig()).toEqual(before);
  });

  it('keeps two empty chains from sharing one configuration (#1021)', async () => {
    const a = (await request('POST', '/api/profiles', { name: 'chain-a', empty: true })).body;
    const b = (await request('POST', '/api/profiles', { name: 'chain-b', empty: true })).body;

    await request('POST', '/api/profiles/active', { profileId: a.id });
    const listed = (await request('GET', '/api/fallback')).body as { modelDbId: number }[];
    await request('PUT', '/api/fallback', listed.map((row, index) => ({
      modelDbId: row.modelDbId,
      priority: index + 1,
      enabled: index < 2,
    })));

    await request('POST', '/api/profiles/active', { profileId: b.id });
    const seenFromB = (await request('GET', '/api/fallback')).body as { enabled: boolean }[];
    expect(seenFromB.every(row => row.enabled === false)).toBe(true);

    // And switching back still shows A's own picks.
    await request('POST', '/api/profiles/active', { profileId: a.id });
    const seenFromA = (await request('GET', '/api/fallback')).body as { enabled: boolean }[];
    expect(seenFromA.filter(row => row.enabled).length).toBe(2);
  });

  it('sorts an empty chain into the chain, not the global table (#1021)', async () => {
    const chain = (await request('POST', '/api/profiles', { name: 'sorted', empty: true })).body;
    await request('POST', '/api/profiles/active', { profileId: chain.id });

    const before = globalConfig();
    const sorted = await request('POST', '/api/fallback/sort/speed');
    expect(sorted.status).toBe(200);

    const rows = getDb().prepare(
      'SELECT model_db_id, priority, enabled FROM profile_models WHERE profile_id = ? ORDER BY priority',
    ).all(chain.id) as { model_db_id: number; priority: number; enabled: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(r => r.priority)).toEqual(rows.map((_, i) => i + 1));
    // A sort orders the list; it must never switch models on behind the operator.
    expect(rows.every(r => r.enabled === 0)).toBe(true);
    expect(globalConfig()).toEqual(before);
  });

  it('reports the flag on the chain listing so the dashboard can show it', async () => {
    await request('POST', '/api/profiles', { name: 'curated', empty: true });
    const { status, body } = await request('GET', '/api/profiles');
    expect(status).toBe(200);

    const curated = body.find((p: { name: string }) => p.name === 'curated');
    expect(curated.auto_include_new_models).toBe(0);
    // The seeded Default chain keeps the old behaviour.
    const fallbackDefault = body.find((p: { type: string }) => p.type === 'default');
    expect(fallbackDefault.auto_include_new_models).toBe(1);
  });
});
