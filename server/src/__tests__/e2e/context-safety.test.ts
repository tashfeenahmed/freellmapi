import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { buildModelListing } from '../../services/model-listing.js';
import { fitsContextWindow } from '../../services/router.js';
import { exhaustedRetryError } from '../../lib/fallback-loop.js';
import { mintDashboardToken } from '../helpers/auth.js';

// End-to-end coverage for the per-model context safety factor:
//   effective context = raw context_window / context_safety_factor
// The same number is advertised by /v1/models (so clients compact early
// enough) and enforced by the router (so a dispatch never exceeds it).

let app: Express;
let dashToken = '';

function seedModel(platform: string, modelId: string, contextWindow: number): number {
  return Number(getDb().prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      monthly_token_budget, context_window, enabled, supports_tools, source
    ) VALUES (?, ?, ?, 5, 5, 'Medium', '', ?, 1, 1, 'catalog')
  `).run(platform, modelId, modelId, contextWindow).lastInsertRowid);
}

function seedKey(platform: string): number {
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, 'x', 'x', 'x', 'healthy', 1)
  `).run(platform, `${platform}-key`).lastInsertRowid);
}

async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: body === undefined ? 'GET' : 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...(body === undefined ? {} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

function modelEntry(models: ReturnType<typeof buildModelListing>['models'], id: string) {
  return models.find(m => m.id === id);
}

async function listModels() {
  const res = await request('/v1/models', undefined, { Authorization: `Bearer ${getUnifiedApiKey()}` });
  expect(res.status, res.text).toBe(200);
  return res.body.data as Array<{ id: string; context_window: number | null }>;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  process.env.UNIFY_MODELS = 'false';
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
});

describe('per-model context safety factor', () => {
  it('PATCH persists the factor and /v1/models advertises raw / factor', async () => {
    const id = seedModel('test', 'model-a', 32768);
    seedKey('test');

    const patch = await request(`/api/models/${id}`, { contextSafetyFactor: 1.25 }, {
      Authorization: `Bearer ${dashToken}`,
    });
    expect(patch.status).toBe(200);

    const row = getDb().prepare('SELECT context_safety_factor FROM models WHERE id = ?').get(id) as { context_safety_factor: number };
    expect(row.context_safety_factor).toBe(1.25);

    const stored = getDb().prepare(
      'SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?'
    ).get('test', 'model-a') as { overrides_json: string };
    expect(JSON.parse(stored.overrides_json).contextSafetyFactor).toBe(1.25);

    const data = await listModels();
    const model = data.find(m => m.id === 'model-a')!;
    expect(model.context_window).toBeCloseTo(32768 / 1.25, 0);

    const auto = data.find(m => m.id === 'auto')!;
    expect(auto.context_window).toBeCloseTo(32768 / 1.25, 0);
  });

  it('a model without an override uses the global 1.25 factor', async () => {
    seedModel('test', 'model-null', 16384);
    seedKey('test');

    const listing = buildModelListing();
    expect(modelEntry(listing.models, 'model-null')?.contextWindow).toBeCloseTo(16384 / 1.25, 0);
    expect(listing.autoContextWindow).toBeCloseTo(16384 / 1.25, 0);

    const data = await listModels();
    expect(data.find(m => m.id === 'model-null')?.context_window).toBeCloseTo(16384 / 1.25, 0);
  });

  it('factor 1.0 advertises the full raw window', async () => {
    const id = seedModel('test', 'model-trust', 32000);
    seedKey('test');

    const patch = await request(`/api/models/${id}`, { contextSafetyFactor: 1.0 }, {
      Authorization: `Bearer ${dashToken}`,
    });
    expect(patch.status).toBe(200);

    const data = await listModels();
    expect(data.find(m => m.id === 'model-trust')?.context_window).toBe(32000);
  });

  it('router fits checks enforce the same per-model factor', () => {
    // effective window 4096 / 1.5 = 2730.67
    expect(fitsContextWindow('test', 4096, 2700, 0, 1.5)).toBe(true);
    expect(fitsContextWindow('test', 4096, 2800, 0, 1.5)).toBe(false);
    // null factor falls back to the global 1.25 → 3276.8
    expect(fitsContextWindow('test', 4096, 3000)).toBe(true);
    expect(fitsContextWindow('test', 4096, 4000)).toBe(false);
    // trust the raw window
    expect(fitsContextWindow('test', 4096, 4000, 0, 1.0)).toBe(true);
  });

  it('context-too-large exhaustion names the largest attempted window', () => {
    const body = exhaustedRetryError(new Error("This model's maximum context length is 32768 tokens"), 3, {
      attempts: [
        { platform: 'test', modelId: 'small', keyOrdinal: 1, errorClass: 'context_too_large', contextWindow: 8192 },
        { platform: 'test', modelId: 'medium', keyOrdinal: 1, errorClass: 'context_too_large', contextWindow: 32768 },
      ],
    });
    expect(body.status).toBe(413);
    expect(body.code).toBe('context_length_exceeded');
    expect(body.message).toContain('Largest context window among attempted models: 32768 tokens');
  });
});
