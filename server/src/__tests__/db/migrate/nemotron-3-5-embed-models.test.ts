import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../db/migrate/runner.js';
import { up, down } from '../../../db/migrations/20261122_000001_nemotron_3_5_embed_models.js';

// The Nemotron 3.5 embed models are live on NVIDIA's API but were missing
// from the embedding catalog (#1979).

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

async function migratedDb(): Promise<Database.Database> {
  const db = new Database(':memory:');
  dbs.push(db);
  await runMigrations(db, 'up');
  return db;
}

function nemotron35Rows(db: Database.Database) {
  return db.prepare(`
    SELECT family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label
    FROM embedding_models
    WHERE platform = 'nvidia' AND model_id LIKE 'nvidia/nemotron-3.5-embed-%'
    ORDER BY model_id
  `).all();
}

describe('nemotron_3_5_embed_models migration (#1979)', () => {
  it('seeds both Nemotron 3.5 embedding rows with the probed dimensions', async () => {
    const db = await migratedDb();
    expect(nemotron35Rows(db)).toEqual([
      {
        family: 'nemotron-3.5-embed-1b', platform: 'nvidia', model_id: 'nvidia/nemotron-3.5-embed-1b',
        display_name: 'Nemotron 3.5 Embed 1B', dimensions: 2048, max_input_tokens: 4096,
        priority: 1, enabled: 1, quota_label: '~40 rpm',
      },
      {
        family: 'nemotron-3.5-embed-8b', platform: 'nvidia', model_id: 'nvidia/nemotron-3.5-embed-8b',
        display_name: 'Nemotron 3.5 Embed 8B', dimensions: 2048, max_input_tokens: 4096,
        priority: 1, enabled: 1, quota_label: '~40 rpm',
      },
    ]);
  });

  it('is idempotent and DOWN removes exactly the rows UP added', async () => {
    const db = await migratedDb();
    up(db);
    up(db);
    expect(nemotron35Rows(db)).toHaveLength(2);
    down(db);
    expect(nemotron35Rows(db)).toHaveLength(0);
    // Pre-existing NVIDIA embedding rows are untouched by DOWN.
    const remaining = db.prepare(
      "SELECT COUNT(*) AS n FROM embedding_models WHERE platform = 'nvidia'",
    ).get() as { n: number };
    expect(remaining.n).toBeGreaterThan(0);
  });
});
