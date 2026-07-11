import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

let dashToken = '';

async function get(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: { Authorization: `Bearer ${dashToken}` },
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

// PR #459 scaled /token-usage budgets by healthy+enabled keys, but the pre-existing
// GET / handler counted enabled=1 only — so the two dashboards disagreed on pooled
// capacity. Both must now use the SAME filter (enabled AND status healthy/unknown),
// matching the routing scorer (#456).
describe('fallback key-count filter parity (#456)', () => {
  let app: Express;
  let modelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();

    const db = getDb();
    // One usable (healthy) groq key and one that must NOT add capacity (invalid).
    const good = encrypt('good'); const bad = encrypt('bad');
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','good',?,?,?,'healthy',1)").run(good.encrypted, good.iv, good.authTag);
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','bad',?,?,?,'invalid',1)").run(bad.encrypted, bad.iv, bad.authTag);

    const m = db.prepare("SELECT model_id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 1").get() as { model_id: string };
    modelId = m.model_id;
    // Non-zero parseable budget so the key multiplier is observable.
    db.prepare("UPDATE models SET monthly_token_budget = '~1M' WHERE platform = 'groq' AND model_id = ?").run(modelId);
  });

  it('GET / counts only enabled healthy/unknown keys (invalid excluded)', async () => {
    const { status, body } = await get(app, '/api/fallback');
    expect(status).toBe(200);
    const row = body.find((r: any) => r.platform === 'groq' && r.modelId === modelId);
    expect(row).toBeDefined();
    // Two enabled groq keys exist, but one is invalid → usable count is 1.
    expect(row.keyCount).toBe(1);
  });

  it('GET / and GET /token-usage agree on the pooled budget for the same model', async () => {
    const listing = await get(app, '/api/fallback');
    const usage = await get(app, '/api/fallback/token-usage');

    const listRow = listing.body.find((r: any) => r.platform === 'groq' && r.modelId === modelId);
    const usageRow = usage.body.models.find((r: any) => r.platform === 'groq' && r.modelId === modelId);

    expect(listRow).toBeDefined();
    expect(usageRow).toBeDefined();
    // Both scale parseBudget('~1M') by the SAME usable key count (1), so the
    // pooled budgets match. Before the fix, GET / used the enabled=2 count.
    expect(listRow.monthlyTokenBudgetTokens).toBe(usageRow.budget);
    expect(usageRow.budget).toBe(1_000_000);
  });
});
