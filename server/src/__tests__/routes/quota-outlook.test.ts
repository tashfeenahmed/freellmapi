import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

let server: Server;
let origin: string;
let token: string;
const httpFetch = globalThis.fetch;
beforeEach(async () => {
  process.env.ENCRYPTION_KEY='0'.repeat(64); initDb(':memory:');
  token=mintDashboardToken();
  server=createApp().listen(0,'127.0.0.1');
  if(!server.listening) await new Promise<void>(resolve=>server.once('listening',resolve));
  origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
});
afterEach(()=>{server.close();vi.restoreAllMocks();});
it('requires dashboard authentication, not the unified inference key', async () => {
  for(const credential of [null,getUnifiedApiKey()]) {
    const response=await httpFetch(origin+'/api/fallback/quota-forecast',{headers:credential?{Authorization:'Bearer '+credential}:{}});
    expect(response.status).toBe(401);
  }
  const response=await httpFetch(origin+'/api/fallback/quota-forecast',{headers:{Authorization:'Bearer '+token}});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({pools:[]});
});
it('returns only outlook data without database changes or provider requests', async () => {
  getDb().prepare(`INSERT INTO provider_quota_state(platform,key_id,quota_pool_key,metric,limit_value,remaining_value,reset_at,notes,observed_at,updated_at)
    VALUES ('groq',1,'groq::account','requests',250,0,'2026-01-01T00:00:00Z','synthetic-private-note',datetime('now'),datetime('now'))`).run();
  const before=getDb().prepare('SELECT total_changes() AS n').get();
  const upstream=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected upstream request'));
  const response=await httpFetch(origin+'/api/fallback/quota-forecast',{headers:{Authorization:'Bearer '+token}});
  expect(response.status).toBe(200);
  const body=await response.json();
  expect(body.pools[0]).toMatchObject({platform:'groq',status:'stale',warning:null,remaining:0});
  expect(JSON.stringify(body)).not.toContain('synthetic-private-note');
  expect(body.pools[0]).not.toHaveProperty('keyId');
  expect(getDb().prepare('SELECT total_changes() AS n').get()).toEqual(before);
  expect(upstream).not.toHaveBeenCalled();
});
