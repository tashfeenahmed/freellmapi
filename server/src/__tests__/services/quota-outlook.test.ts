import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getQuotaOutlook } from '../../services/quota-outlook.js';
import { getQuotaForecast } from '../../services/quota-forecast.js';
import { getQuotaStateForKeys, recordQuotaObservation, recordQuotaObservationsFromResponse } from '../../services/provider-quota.js';

const NOW = Date.parse('2026-09-14T20:00:00Z');
function signal(overrides: Partial<{ platform: string; pool: string; key: number; limit: number | null; remaining: number | null; reset: string | null; observed: string; metric: string; confidence: number }> = {}) {
  const row = { platform: 'groq', pool: 'groq::account', key: 1, limit: 250, remaining: 35,
    reset: '2026-09-15T00:00:00Z', observed: '2026-09-14 19:59:00', metric: 'requests', confidence: 1, ...overrides };
  getDb().prepare(`INSERT INTO provider_quota_state
    (platform,key_id,quota_pool_key,metric,limit_value,remaining_value,reset_at,observed_at,updated_at,confidence)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.platform,row.key,row.pool,row.metric,row.limit,row.remaining,row.reset,row.observed,row.observed,row.confidence);
}
function traffic(count: number, key = 1, platform = 'groq', model = 'llama') {
  const insert = getDb().prepare(`INSERT INTO requests(platform,model_id,key_id,status,input_tokens,output_tokens,latency_ms,created_at)
    VALUES (?,?,?,'success',10,5,100,'2026-09-14 19:59:00')`);
  for (let i = 0; i < count; i++) insert.run(platform,model,key);
}
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

describe('dashboard quota outlook', () => {
  it('uses the existing rate projection and warns below 20% without changing the API threshold', () => {
    signal(); traffic(7);
    const pool = getQuotaOutlook().pools[0];
    expect(pool).toMatchObject({remaining:35,remainingPct:14,ratePerMin:0.7,status:'forecast',warning:'low_balance',estimatedExhaustionAt:'2026-09-14T20:50:00.000Z'});
    expect(getQuotaForecast(getQuotaStateForKeys({ normalizeExpired: false }), NOW)[0].low_balance).toBe(false);
  });

  it('warns at two hours even above 20%, but not when reset wins', () => {
    signal({remaining:75}); traffic(10);
    expect(getQuotaOutlook().pools[0]).toMatchObject({status:'forecast',warning:'exhausting_soon'});
    getDb().prepare("UPDATE provider_quota_state SET reset_at='2026-09-14T20:30:00Z'").run();
    expect(getQuotaOutlook().pools[0]).toMatchObject({status:'resets_first',warning:null,estimatedExhaustionAt:null});
  });

  it('keeps the 20% boundary strict and the two-hour boundary inclusive', () => {
    signal({remaining:50});
    expect(getQuotaOutlook().pools[0]).toMatchObject({status:'insufficient_data',warning:null});
    getDb().prepare('UPDATE provider_quota_state SET remaining_value=120').run(); traffic(10);
    expect(getQuotaOutlook().pools[0].warning).toBe('exhausting_soon');
    getDb().prepare('UPDATE provider_quota_state SET remaining_value=121').run();
    expect(getQuotaOutlook().pools[0].warning).toBeNull();
  });

  it('distinguishes sparse traffic from an exhausted current window', () => {
    signal({remaining:100}); traffic(2);
    expect(getQuotaOutlook().pools[0]).toMatchObject({status:'insufficient_data',ratePerMin:0.2,recentRequestCount:2,warning:null});
    getDb().prepare('UPDATE provider_quota_state SET remaining_value=0').run();
    expect(getQuotaOutlook().pools[0]).toMatchObject({status:'exhausted',warning:'low_balance',estimatedExhaustionAt:null});
  });

  it.each([
    {reset:null}, {reset:'invalid'}, {reset:'2026-09-14T19:00:00Z'},
    {observed:'2026-09-14 19:40:00'}, {observed:'2026-09-14 20:10:00'},
    {observed:'invalid'}, {confidence:0.1},
  ])('does not turn unusable observations into current forecasts: %j', overrides => {
    signal(overrides); traffic(10);
    expect(getQuotaOutlook().pools[0]).toMatchObject({warning:null,ratePerMin:1,recentRequestCount:10,estimatedExhaustionAt:null});
    expect(getQuotaOutlook().pools[0].unavailableReason).not.toBeNull();
  });

  it('keeps unknown request pools visible while token signals remain outside the forecast', () => {
    signal({limit:null,remaining:null}); signal({metric:'tokens'});
    expect(getQuotaOutlook().pools).toHaveLength(1);
    expect(getQuotaOutlook().pools[0]).toMatchObject({status:'unknown',remaining:null,remainingPct:null,warning:null});
  });

  it('preserves forecast tie-breaking and counts the shared pool once', () => {
    signal({key:1,limit:1000,remaining:144}); signal({key:2,limit:1000,remaining:141});
    traffic(5,1); traffic(5,2);
    const {pools} = getQuotaOutlook();
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({remaining:144,ratePerMin:1,estimatedExhaustionAt:'2026-09-14T22:24:00.000Z'});
  });

  it('prefers a known full balance over a preceding unknown balance', () => {
    signal({key:1,limit:null,remaining:null}); signal({key:2,remaining:250});
    expect(getQuotaOutlook().pools[0]).toMatchObject({remaining:250,status:'insufficient_data'});
  });

  it('does not write expired balances or trigger upstream calls', () => {
    signal({remaining:0,reset:'2026-01-01T00:00:00Z'});
    const before = getDb().prepare('SELECT * FROM provider_quota_state').all();
    const changes = getDb().prepare('SELECT total_changes() AS n').get();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No upstream traffic permitted'));
    expect(getQuotaOutlook().pools[0].status).toBe('stale');
    expect(getDb().prepare('SELECT * FROM provider_quota_state').all()).toEqual(before);
    expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});


it('records usage independently for a provider with no quota readings or request limits', () => {
  traffic(2,1,'kilo','free-model');
  expect(getQuotaOutlook()).toMatchObject({observationWindowMinutes:10,minimumRequests:3,pools:[{
    platform:'kilo',recentRequestCount:2,ratePerMin:0.2,remaining:null,limit:null,
    estimatedExhaustionAt:null,status:'unknown',unavailableReason:'quota_not_reported',
  }]});
  traffic(8,1,'kilo','another-model');
  expect(getQuotaOutlook().pools).toHaveLength(1);
  expect(getQuotaOutlook().pools[0]).toMatchObject({recentRequestCount:10,ratePerMin:1,estimatedExhaustionAt:null});
});

it('prefers a current observation over an exhausted stale legacy key and counts each request once', () => {
  signal({key:0,remaining:0,observed:'2026-07-30 10:00:00'});
  signal({key:1,remaining:100});traffic(10);
  expect(getQuotaOutlook().pools).toHaveLength(1);
  expect(getQuotaOutlook().pools[0]).toMatchObject({remaining:100,ratePerMin:1,status:'forecast'});
});

it('forecasts from real Groq duration headers and retains freshness after an empty health probe', () => {
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(NOW);
  try {
    recordQuotaObservationsFromResponse(new Response(null,{headers:{
      'x-ratelimit-limit-requests':'100','x-ratelimit-remaining-requests':'10','x-ratelimit-reset-requests':'1h30m',
    }}),{platform:'groq',keyId:1});traffic(10);
    expect(getQuotaOutlook().pools[0]).toMatchObject({status:'forecast',warning:'low_balance',ratePerMin:1,estimatedExhaustionAt:'2026-09-14T20:10:00.000Z'});
    vi.setSystemTime(NOW+11*60000);
    recordQuotaObservation({platform:'groq',keyId:1,source:'probe',confidence:0.1});
    expect(getQuotaOutlook().pools[0]).toMatchObject({status:'stale',unavailableReason:'stale_observation',warning:null,estimatedExhaustionAt:null});
  } finally {vi.useRealTimers();}
});

it('retains the last actual zero after another panel reads expired headroom', () => {
  signal({remaining:0,reset:'2026-09-14T19:30:00Z'});
  getQuotaStateForKeys();
  expect(getQuotaOutlook().pools[0]).toMatchObject({remaining:0,status:'stale',warning:null});
});


it('includes keyless successful usage but excludes failed, old and future traffic', () => {
  const insert=getDb().prepare(`INSERT INTO requests(platform,model_id,key_id,status,created_at) VALUES ('kilo','free',NULL,?,?)`);
  insert.run('success','2026-09-14 19:59:00');
  insert.run('error','2026-09-14 19:59:00');
  insert.run('success','2026-09-14 19:00:00');
  insert.run('success','2026-09-14 20:01:00');
  expect(getQuotaOutlook().pools[0]).toMatchObject({recentRequestCount:1,ratePerMin:0.1,estimatedExhaustionAt:null});
});


it('normalizes SQLite UTC reset timestamps before projecting exhaustion', () => {
  signal({remaining:100,reset:'2026-09-14 20:30:00'});traffic(10);
  expect(getQuotaOutlook().pools[0]).toMatchObject({resetAt:'2026-09-14T20:30:00.000Z',status:'resets_first',estimatedExhaustionAt:null});
});
