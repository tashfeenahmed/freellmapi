import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { buildCodexCatalog } from '../../services/codex-catalog.js';

let app: Express;

async function get(path: string, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, { headers });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

function addModel(modelId: string, priority: number): void {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget,
      context_window, enabled, supports_vision, supports_tools
    )
    VALUES ('groq', ?, ?, ?, ?, 'Small', NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(modelId, `Codex ${modelId}`, priority, priority);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  const db = getDb();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM models').run();
  const secret = encrypt('groq-codex-catalog-key');
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('groq', 'codex-catalog', ?, ?, ?, 'healthy', 1)
  `).run(secret.encrypted, secret.iv, secret.authTag);
  addModel('alpha-model', 1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /v1/codex/models', () => {
  it('rejects a missing API key', async () => {
    const res = await get('/v1/codex/models');
    expect(res.status).toBe(401);
  });

  it('serves a Codex-shaped catalog with the fields Codex requires', async () => {
    const res = await get('/v1/codex/models', { Authorization: `Bearer ${getUnifiedApiKey()}` });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(res.body.models.length).toBeGreaterThan(0);
    for (const m of res.body.models) {
      expect(typeof m.slug).toBe('string');
      expect(typeof m.display_name).toBe('string');
      expect(m.context_window).toBeGreaterThan(0);
      expect(m.max_context_window).toBe(m.context_window);
      expect(typeof m.base_instructions).toBe('string');
      expect(m.base_instructions.length).toBeGreaterThan(0);
      expect(m.apply_patch_tool_type).toBe('freeform');
      expect(Array.isArray(m.experimental_supported_tools)).toBe(true);
    }
  });

  it('lists the same models, with the same context windows, as /v1/models', async () => {
    const auth = { Authorization: `Bearer ${getUnifiedApiKey()}` };
    const codex = await get('/v1/codex/models', auth);
    const openai = await get('/v1/models?available=true', auth);
    const expected = openai.body.data.map((m: any) => [m.id, m.context_window]);
    expect(expected.length).toBeGreaterThan(0);
    expect(codex.body.models.map((m: any) => [m.slug, m.context_window])).toEqual(expected);
  });
});

describe('buildCodexCatalog', () => {
  it('skips entries without a known context window instead of inventing one', () => {
    const out = buildCodexCatalog([
      { id: 'known', name: 'Known', context_window: 4096 },
      { id: 'unknown', name: 'Unknown', context_window: null },
      { id: '', name: 'No id', context_window: 4096 },
    ]);
    expect(out.models.map(m => m.slug)).toEqual(['known']);
  });
});
