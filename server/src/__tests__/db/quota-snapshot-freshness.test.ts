import { beforeEach, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { up, down } from '../../db/migrations/20260915_000001_quota_snapshot_freshness.js';
import { recordQuotaObservation } from '../../services/provider-quota.js';

beforeEach(() => { process.env.ENCRYPTION_KEY='0'.repeat(64);initDb(':memory:'); });

it('repairs probe-refreshed balances from the last real measurement, preserving empty probe history', () => {
  recordQuotaObservation({platform:'groq',keyId:1,limit:100,remaining:20,resetAt:'2026-09-15T13:00:00Z',
    source:'header',observedAt:'2026-09-15T11:00:00Z'});
  recordQuotaObservation({platform:'groq',keyId:1,source:'probe',confidence:0.1,observedAt:'2026-09-15T12:00:00Z'});
  getDb().prepare("UPDATE provider_quota_state SET remaining_value=100,reset_at=NULL,observed_at='2026-09-15 12:00:00',notes='no quota headers exposed'").run();
  const history=getDb().prepare('SELECT * FROM provider_quota_observations').all();
  up(getDb());
  expect(getDb().prepare('SELECT remaining_value,reset_at,observed_at,confidence,notes FROM provider_quota_state').get())
    .toEqual({remaining_value:20,reset_at:'2026-09-15T13:00:00Z',observed_at:'2026-09-15 11:00:00.000',confidence:1,notes:null});
  expect(getDb().prepare('SELECT * FROM provider_quota_observations').all()).toEqual(history);
  const repaired=getDb().prepare('SELECT * FROM provider_quota_state').all();
  up(getDb());down(getDb());
  expect(getDb().prepare('SELECT * FROM provider_quota_state').all()).toEqual(repaired);
});

it('does not retain borrowed confidence or guess the age of a pruned balance', () => {
  recordQuotaObservation({platform:'groq',keyId:1,remaining:0,source:'error_body',confidence:1});
  recordQuotaObservation({platform:'cerebras',keyId:2,remaining:50,limit:100,source:'header'});
  getDb().prepare("DELETE FROM provider_quota_observations WHERE platform='cerebras'").run();
  up(getDb());
  expect(getDb().prepare("SELECT confidence FROM provider_quota_state WHERE platform='groq'").get()).toEqual({confidence:0.55});
  expect(getDb().prepare("SELECT remaining_value,confidence FROM provider_quota_state WHERE platform='cerebras'").get()).toEqual({remaining_value:50,confidence:0});
});
