// M08/M10: an upstream retirement (#634) switches a model off in every chain,
// and a newer catalog that still lists it lifts the retirement. The lift used
// to force EVERY chain flag back to 1, so a chain the user had switched the
// model off in came back on behind their back. Retirement now remembers the
// flags it overwrote and the lift puts exactly those back.
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  getCatalogModelTombstone,
  recordCatalogModelTombstone,
  reinstateUpstreamRetiredCatalogModel,
  retireCatalogModelUpstream,
  setChainEnabled,
} from '../../services/model-state.js';

const PLATFORM = 'groq';
const MODEL_ID = 'lifecycle-test-model';

function seed(): { modelDbId: number; profileOn: number; profileOff: number } {
  const db = getDb();
  db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, 'Lifecycle', 50, 50, 1, 'catalog')`).run(PLATFORM, MODEL_ID);
  const modelDbId = (db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(PLATFORM, MODEL_ID) as { id: number }).id;
  // The user switched it off in the global chain...
  db.prepare(`INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 999, 0)
    ON CONFLICT(model_db_id) DO UPDATE SET enabled = 0`).run(modelDbId);
  // ...kept it on in one profile and off in another.
  const profile = (name: string) => Number(db.prepare('INSERT INTO profiles (name) VALUES (?)').run(name).lastInsertRowid);
  const profileOn = profile('on'), profileOff = profile('off');
  const link = db.prepare(`INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, ?)
    ON CONFLICT(profile_id, model_db_id) DO UPDATE SET enabled = excluded.enabled`);
  link.run(profileOn, modelDbId, 1);
  link.run(profileOff, modelDbId, 0);
  return { modelDbId, profileOn, profileOff };
}

function flags(modelDbId: number, profileOn: number, profileOff: number) {
  const db = getDb();
  const fb = (db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?').get(modelDbId) as { enabled: number }).enabled;
  const p = (id: number) => (db.prepare('SELECT enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?')
    .get(id, modelDbId) as { enabled: number }).enabled;
  return { fallback: fb, on: p(profileOn), off: p(profileOff) };
}

describe('chain flags across an upstream retirement', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('retirement switches the model off everywhere', () => {
    const { modelDbId, profileOn, profileOff } = seed();
    expect(retireCatalogModelUpstream(getDb(), modelDbId, PLATFORM, MODEL_ID, 'HTTP 410 gone')).toBe(true);
    expect(flags(modelDbId, profileOn, profileOff)).toEqual({ fallback: 0, on: 0, off: 0 });
  });

  it('reinstating puts back exactly the flags retirement overwrote', () => {
    const { modelDbId, profileOn, profileOff } = seed();
    retireCatalogModelUpstream(getDb(), modelDbId, PLATFORM, MODEL_ID, 'HTTP 410 gone');

    expect(reinstateUpstreamRetiredCatalogModel(getDb(), PLATFORM, MODEL_ID)).toBe(true);

    expect(flags(modelDbId, profileOn, profileOff)).toEqual({ fallback: 0, on: 1, off: 0 });
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID)).toBeUndefined();
  });

  it('a chain row added while retired keeps its own flag on reinstate', () => {
    const { modelDbId, profileOn, profileOff } = seed();
    retireCatalogModelUpstream(getDb(), modelDbId, PLATFORM, MODEL_ID, 'HTTP 410 gone');
    const late = Number(getDb().prepare("INSERT INTO profiles (name) VALUES ('late')").run().lastInsertRowid);
    getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 0)').run(late, modelDbId);

    reinstateUpstreamRetiredCatalogModel(getDb(), PLATFORM, MODEL_ID);

    expect(flags(modelDbId, profileOn, profileOff)).toEqual({ fallback: 0, on: 1, off: 0 });
    expect((getDb().prepare('SELECT enabled FROM profile_models WHERE profile_id = ?').get(late) as { enabled: number }).enabled).toBe(0);
  });

  it('a retirement recorded before snapshots existed still reinstates everything (old behaviour)', () => {
    const { modelDbId, profileOn, profileOff } = seed();
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID, { source: 'upstream_eol', reason: 'legacy' });

    reinstateUpstreamRetiredCatalogModel(getDb(), PLATFORM, MODEL_ID);

    expect(flags(modelDbId, profileOn, profileOff)).toEqual({ fallback: 1, on: 1, off: 1 });
  });
});

describe('setChainEnabled', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('scope "all" writes the global chain and every profile', () => {
    const { modelDbId, profileOn, profileOff } = seed();
    setChainEnabled(getDb(), modelDbId, false, { scope: 'all' });
    expect(flags(modelDbId, profileOn, profileOff)).toEqual({ fallback: 0, on: 0, off: 0 });
  });

  it('scope "active" writes the global chain and only the active profile', () => {
    const { modelDbId, profileOn, profileOff } = seed();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(profileOff));
    setChainEnabled(getDb(), modelDbId, true, { scope: 'active' });
    expect(flags(modelDbId, profileOn, profileOff)).toEqual({ fallback: 1, on: 1, off: 1 });
  });

  // Switching a retired model back on is the user disagreeing with the
  // retirement: it must not stay routed while the dashboard still says
  // "retired upstream", and a later end-of-life signal must be able to retire
  // it again (an existing tombstone blocks that).
  it('switching a retired model back on lifts the retirement', () => {
    const { modelDbId } = seed();
    retireCatalogModelUpstream(getDb(), modelDbId, PLATFORM, MODEL_ID, 'HTTP 410 gone');

    setChainEnabled(getDb(), modelDbId, true, { scope: 'active' });

    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID)).toBeUndefined();
    expect(retireCatalogModelUpstream(getDb(), modelDbId, PLATFORM, MODEL_ID, 'HTTP 410 again')).toBe(true);
  });

  it('switching a model on never lifts a user deletion tombstone', () => {
    const { modelDbId } = seed();
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID, { source: 'user' });
    setChainEnabled(getDb(), modelDbId, true, { scope: 'active' });
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID)?.source).toBe('user');
  });
});
