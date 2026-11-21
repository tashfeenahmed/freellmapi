import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { initDb, getDb } from '../../db/index.js';
import { keysRouter } from '../../routes/keys.js';
import { modelsRouter } from '../../routes/models.js';
import { fallbackRouter } from '../../routes/fallback.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/keys', keysRouter);
  app.use('/api/models', modelsRouter);
  app.use('/api/fallback', fallbackRouter);
  return app;
}

async function request(app: express.Express, method: string, path: string, body?: unknown) {
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('Custom provider monthly token budget (#2030)', () => {
  let app: express.Express;

  beforeEach(() => {
    process.env.ALLOW_PRIVATE_CUSTOM_URLS = 'true';
    initDb(':memory:');
    app = createApp();
  });

  afterEach(() => {
    delete process.env.ALLOW_PRIVATE_CUSTOM_URLS;
  });

  it('registers monthlyTokenBudget on POST /api/keys/custom and surfaces it in GET /api/fallback/token-usage', async () => {
    const add = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18080/v1',
      models: ['my-custom-llama'],
      apiKey: 'sk-custom-budget-1',
      monthlyTokenBudget: '~30M',
    });
    expect(add.status).toBe(201);

    const usage = await request(app, 'GET', '/api/fallback/token-usage');
    expect(usage.status).toBe(200);
    const entry = usage.body.models.find((m: any) => m.platform === 'custom' && m.modelId === 'my-custom-llama');
    expect(entry).toBeDefined();
    expect(entry.budget).toBe(30_000_000);
    expect(usage.body.totalBudget).toBe(30_000_000);

    // Adding a second key to the same custom endpoint doubles its pooled budget
    const addKey2 = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18080/v1',
      apiKey: 'sk-custom-budget-2',
    });
    expect(addKey2.status).toBe(201);

    const usage2 = await request(app, 'GET', '/api/fallback/token-usage');
    const entry2 = usage2.body.models.find((m: any) => m.platform === 'custom' && m.modelId === 'my-custom-llama');
    expect(entry2.budget).toBe(60_000_000);
    expect(usage2.body.totalBudget).toBe(60_000_000);
  });

  it('derives monthly token budget from tpdLimit * 30 when monthly_token_budget is empty', async () => {
    const add = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18081/v1',
      models: ['custom-tpd-model'],
      apiKey: 'sk-custom-tpd-1',
    });
    expect(add.status).toBe(201);

    const modelId = add.body.models[0].modelDbId;
    const patch = await request(app, 'PATCH', `/api/models/${modelId}`, { tpdLimit: 1_000_000 });
    expect(patch.status).toBe(200);

    const usage = await request(app, 'GET', '/api/fallback/token-usage');
    const entry = usage.body.models.find((m: any) => m.modelDbId === modelId);
    expect(entry).toBeDefined();
    expect(entry.budget).toBe(30_000_000);
    expect(usage.body.totalBudget).toBe(30_000_000);

    // Parity with GET /api/fallback
    const fallback = await request(app, 'GET', '/api/fallback');
    const fbEntry = fallback.body.find((m: any) => m.modelDbId === modelId);
    expect(fbEntry.monthlyTokenBudgetTokens).toBe(30_000_000);
  });

  it('stores a plain digit budget in unit form and rejects text that is not a token budget', async () => {
    const add = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18085/v1',
      models: ['digits-model'],
      apiKey: 'sk-digits-1',
      monthlyTokenBudget: '30000000',
    });
    expect(add.status).toBe(201);
    const usage = await request(app, 'GET', '/api/fallback/token-usage');
    expect(usage.body.models.find((m: any) => m.modelId === 'digits-model')?.budget).toBe(30_000_000);
    const fallback = await request(app, 'GET', '/api/fallback');
    const row = fallback.body.find((m: any) => m.modelId === 'digits-model');
    expect(row.monthlyTokenBudget).toBe('30M');
    expect(row.monthlyTokenBudgetDerived).toBe(false);

    const bad = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18086/v1',
      models: ['bad-model'],
      apiKey: 'sk-bad-1',
      monthlyTokenBudget: '40 RPM',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/monthlyTokenBudget/);

    const badModel = await request(app, 'POST', '/api/models', {
      platform: 'custom', modelId: 'bad-model-2', monthlyTokenBudget: 'lots',
    });
    expect(badModel.status).toBe(400);
    expect(badModel.body.error.message).toMatch(/monthlyTokenBudget/);
  });

  it('flags a tpd-derived budget so the model table prints the number, not the empty label', async () => {
    const add = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18087/v1',
      models: ['derived-model'],
      apiKey: 'sk-derived-1',
    });
    const modelId = add.body.models[0].modelDbId;
    await request(app, 'PATCH', `/api/models/${modelId}`, { tpdLimit: 100_000 });
    const fallback = await request(app, 'GET', '/api/fallback');
    const row = fallback.body.find((m: any) => m.modelDbId === modelId);
    expect(row.monthlyTokenBudget).toBe('');
    expect(row.monthlyTokenBudgetTokens).toBe(3_000_000);
    expect(row.monthlyTokenBudgetDerived).toBe(true);
  });

  it('uses key monthlyTokenCap when custom models have no model-level budget, without double-counting', async () => {
    const add = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18082/v1',
      models: ['cap-model-a', 'cap-model-b'],
      apiKey: 'sk-custom-cap-1',
    });
    expect(add.status).toBe(201);

    const patchKey = await request(app, 'PATCH', `/api/keys/${add.body.keyId}`, {
      monthlyTokenCap: 10_000_000,
    });
    expect(patchKey.status).toBe(200);

    const usage = await request(app, 'GET', '/api/fallback/token-usage');
    const entries = usage.body.models.filter((m: any) => m.platform === 'custom');
    expect(entries).toHaveLength(2);
    expect(usage.body.totalBudget).toBe(10_000_000);
    expect(entries.reduce((sum: number, m: any) => sum + m.budget, 0)).toBe(10_000_000);
  });

  it('scopes custom endpoint key counts and enabled state per endpoint, not across all custom keys', async () => {
    const ep1 = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18083/v1',
      models: ['ep1-model'],
      apiKey: 'sk-ep1-key1',
      monthlyTokenBudget: '~10M',
    });
    expect(ep1.status).toBe(201);

    const ep2 = await request(app, 'POST', '/api/keys/custom', {
      baseUrl: 'http://127.0.0.1:18084/v1',
      models: ['ep2-model'],
      apiKey: 'sk-ep2-key1',
      monthlyTokenBudget: '~20M',
    });
    expect(ep2.status).toBe(201);

    // Each endpoint has 1 key, so ep1 = 10M and ep2 = 20M (total 30M, NOT 60M)
    const usage = await request(app, 'GET', '/api/fallback/token-usage');
    expect(usage.body.models.find((m: any) => m.modelId === 'ep1-model')?.budget).toBe(10_000_000);
    expect(usage.body.models.find((m: any) => m.modelId === 'ep2-model')?.budget).toBe(20_000_000);
    expect(usage.body.totalBudget).toBe(30_000_000);

    // Disabling ep1 removes ep1's budget while keeping ep2's budget intact
    await request(app, 'PATCH', `/api/keys/${ep1.body.keyId}`, { enabled: false });
    const usageAfterDisable = await request(app, 'GET', '/api/fallback/token-usage');
    expect(usageAfterDisable.body.models.find((m: any) => m.modelId === 'ep1-model')).toBeUndefined();
    expect(usageAfterDisable.body.models.find((m: any) => m.modelId === 'ep2-model')?.budget).toBe(20_000_000);
    expect(usageAfterDisable.body.totalBudget).toBe(20_000_000);

    // Removing ep2 removes its budget completely
    await request(app, 'DELETE', `/api/keys/${ep2.body.keyId}`);
    const usageAfterDelete = await request(app, 'GET', '/api/fallback/token-usage');
    expect(usageAfterDelete.body.totalBudget).toBe(0);
    expect(getDb().prepare("SELECT COUNT(*) as c FROM models WHERE platform = 'custom'").get()).toBeDefined();
  });
});
