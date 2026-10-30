import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, setSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { applyPlacementPins, readPlacementPins } from '../../services/embedding-placement.js';

// A provider row can be dragged into another embedding family. The routing unit is
// the family (one model identity + one dimension), so the move has to be validated
// on the server — the dashboard cannot be the only thing standing between a typo
// and two vector spaces sharing a family.

let dashToken = '';
let app: Express;

async function put(body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/embeddings`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${dashToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function seed(
  family: string,
  platform: string,
  modelId: string,
  priority: number,
  dimensions = 1024,
): number {
  const info = getDb().prepare(`
    INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, ?, 1, 'test')
  `).run(family, platform, modelId, modelId, dimensions, priority);
  return Number(info.lastInsertRowid);
}

function rowsOf(family: string) {
  return getDb()
    .prepare('SELECT id, priority, family FROM embedding_models WHERE family = ? ORDER BY priority')
    .all(family) as { id: number; priority: number; family: string }[];
}

function familyOf(id: number): string {
  return (getDb().prepare('SELECT family FROM embedding_models WHERE id = ?').get(id) as { family: string }).family;
}

describe('PUT /api/embeddings — moving a provider into another family', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM embedding_models').run();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('appends the moved row to the end of the target family', async () => {
    const cf = seed('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1);
    const sl = seed('bge-m3', 'sealion', 'BAAI/bge-m3', 2);
    const sf = seed('BAAI/bge-m3', 'custom', 'BAAI/bge-m3', 0);

    const { status } = await put({ providers: [{ id: sf, priority: 0, enabled: true, family: 'bge-m3' }] });
    expect(status).toBe(200);

    expect(rowsOf('bge-m3').map(r => r.id)).toEqual([cf, sl, sf]);
    expect(rowsOf('bge-m3').map(r => r.priority)).toEqual([1, 2, 3]);
    expect(rowsOf('BAAI/bge-m3')).toEqual([]);
  });

  // Regression: a bare `SELECT dimensions, MAX(priority) ... WHERE family = ?`
  // returns one all-NULL row for an unknown family, which reported the miss as a
  // dimension mismatch ("is null dimensions") instead of the real reason.
  it('rejects an unknown family by name', async () => {
    const id = seed('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1);

    const { status, body } = await put({ providers: [{ id, priority: 1, enabled: true, family: 'nope' }] });
    expect(status).toBe(400);
    expect(body.error.message).toBe("Unknown family 'nope'");
    expect(familyOf(id)).toBe('bge-m3');
  });

  it('refuses a family whose dimensions differ, and leaves the row in place', async () => {
    const id = seed('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1);
    seed('gemini-embedding-001', 'google', 'gemini-embedding-001', 1, 3072);

    const { status, body } = await put({
      providers: [{ id, priority: 1, enabled: true, family: 'gemini-embedding-001' }],
    });
    expect(status).toBe(400);
    expect(body.error.message).toContain('is 3072 dimensions, but model');
    expect(familyOf(id)).toBe('bge-m3');
    expect(readPlacementPins(getDb())).toEqual({});
  });

  it('follows the move when the default family would be left empty', async () => {
    const id = seed('solo', 'custom', 'BAAI/bge-m3', 0);
    seed('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1);
    setSetting('embeddings_default_family', 'solo');

    const { status } = await put({ providers: [{ id, priority: 0, enabled: true, family: 'bge-m3' }] });
    expect(status).toBe(200);
    expect(getDb().prepare("SELECT value FROM settings WHERE key = 'embeddings_default_family'").get()).toEqual({
      value: 'bge-m3',
    });
  });

  it('records the placement so a catalog re-apply cannot undo it', async () => {
    const cf = seed('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1);
    const sf = seed('BAAI/bge-m3', 'custom', 'BAAI/bge-m3', 0);

    await put({ providers: [{ id: sf, priority: 0, enabled: true, family: 'bge-m3' }] });
    expect(readPlacementPins(getDb())).toEqual({ [String(sf)]: { family: 'bge-m3', priority: 2 } });

    // Stand-in for catalog-sync rewriting the row from its snapshot.
    getDb().prepare('UPDATE embedding_models SET family = ?, priority = ? WHERE id = ?').run('BAAI/bge-m3', 0, sf);
    applyPlacementPins(getDb());
    expect(familyOf(sf)).toBe('bge-m3');
    expect(rowsOf('bge-m3').map(r => r.id)).toEqual([cf, sf]);
  });

  it('still edits priority and enabled without touching the family', async () => {
    const a = seed('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1);
    const b = seed('bge-m3', 'sealion', 'BAAI/bge-m3', 2);

    const { status } = await put({
      providers: [
        { id: a, priority: 2, enabled: false },
        { id: b, priority: 1, enabled: true },
      ],
    });
    expect(status).toBe(200);
    expect(rowsOf('bge-m3').map(r => r.id)).toEqual([b, a]);
    expect(readPlacementPins(getDb())).toEqual({});
  });
});
