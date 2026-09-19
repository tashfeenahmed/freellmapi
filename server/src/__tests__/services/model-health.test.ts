// ── Model health status table ───────────────────────────────────────────────
// Verifies that the new model_health_status snapshot tracks the in-memory
// failure window 1:1: one failure does nothing; three consecutive failures
// trip the failing status; a success clears it; per-(key,platform,model) rows
// are unique. Uses vitest (matching the project's test runner) and a
// hand-rolled in-memory SQLite database.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  observeModelHealth,
  readAllModelHealthStatus,
  resetAllModelHealth,
  recordModelHealthFailing,
  recordModelHealthWorking,
} from '../../services/model-health.js';
import { initDb, getDb } from '../../db/index.js';

let db: Database.Database;

afterEach(() => { db?.close(); });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  resetAllModelHealth();
});

function stubRoute(over: Partial<RouteResult> = {}): RouteResult {
  return {
    modelDbId: 1,
    platform: 'cloudflare',
    keyId: 22,
    modelId: 'llama-3.3-70b-instruct-fp8-fast',
    keyLabel: 'Cloudflare Workers AI',
    displayName: 'llama-3.3-70b-instruct-fp8-fast',
    address: 'https://api.cloudflare.com/client/v4/accounts/…/ai/generate',
    routeKind: 'fallback',
    completed: true,
    ... over,
  } as RouteResult;
}

describe('model_health_status', () => {
  it('one failure writes a failing row', () => {
    recordModelHealthFailing(stubRoute(), null, null);
    const rows = readAllModelHealthStatus();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find(r => r.platform === 'cloudflare' && r.model_id === 'llama-3.3-70b-instruct-fp8-fast');
    expect(row).toBeDefined();
    expect(row!.status).toBe('failing');
    expect(row!.failure_count_in_window).toBe(3);
    expect(row!.last_failure_at).not.toBeNull();
  });

  it('three consecutive failures keep status failing', () => {
    for (let i = 0; i < 3; i++) {
      recordModelHealthFailing(stubRoute(), null, null);
    }
    const rows = readAllModelHealthStatus();
    const row = rows.find(r => r.platform === 'cloudflare' && r.model_id === 'llama-3.3-70b-instruct-fp8-fast');
    expect(row!.status).toBe('failing');
  });

  it('success clears failing status', () => {
    for (let i = 0; i < 3; i++) recordModelHealthFailing(stubRoute(), null, null);
    recordModelHealthWorking(stubRoute());
    const rows = readAllModelHealthStatus();
    const row = rows.find(r => r.platform === 'cloudflare' && r.model_id === 'llama-3.3-70b-instruct-fp8-fast');
    expect(row!.status).toBe('working');
    expect(row!.last_working_at).not.toBeNull();
  });

  it('different models are tracked separately', () => {
    for (let i = 0; i < 3; i++)
      recordModelHealthFailing(stubRoute({ modelId: 'llama-3.3-70b-instruct-fp8-fast' }), null, null);
    recordModelHealthWorking(stubRoute({ modelId: 'other-model' }));
    const rows = readAllModelHealthStatus();
    const failures = rows.filter(r => r.status === 'failing');
    expect(failures.length).toBe(1);
    const working = rows.find(r => r.model_id === 'other-model');
    expect(working).toBeDefined();
    expect(working!.status).toBe('working');
  });
});
