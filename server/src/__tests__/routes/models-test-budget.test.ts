import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { getProvider } from '../../providers/index.js';
import { checkMonthlyBudget, getMonthlyUsage } from '../../services/key-budget.js';

let server: Server;
let keyId: number;
let ids: number[];
let token: string;
let sequence = 20000;
const answer = {id:'mock',object:'chat.completion',created:0,model:'mock',choices:[{index:0,message:{role:'assistant' as const,content:'pong'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}};
const post = async (path: string, body?: object) => {
  const res = await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+path, {
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body && JSON.stringify(body),
  });
  return {status:res.status,body:await res.json()};
};
beforeEach(async () => {
  process.env.ENCRYPTION_KEY='0'.repeat(64); initDb(':memory:'); const db=getDb();
  const {encrypted,iv,authTag}=encrypt('synthetic-test-key');
  keyId=Number(db.prepare("INSERT INTO api_keys(platform,label,encrypted_key,iv,auth_tag,status,enabled,monthly_request_cap) VALUES ('groq','test',?,?,?,'healthy',1,1)").run(encrypted,iv,authTag).lastInsertRowid);
  ids = [++sequence,++sequence];
  for(const id of ids) db.prepare("INSERT INTO models(id,platform,model_id,display_name,intelligence_rank,speed_rank,size_label,enabled) VALUES (?,'groq',?,'Test',1,1,'Small',1)").run(id,'test-'+id);
  server=createApp().listen(0,'127.0.0.1');
  if(!server.listening) await new Promise<void>(r=>server.once('listening',r));
  token=mintDashboardToken();
});
afterEach(()=>{server.close(); vi.restoreAllMocks();});
it('does not dispatch with an exhausted monthly request budget', async () => {
  getDb().prepare('INSERT INTO key_monthly_usage(key_id,month,requests,tokens) VALUES (?,?,1,10)').run(keyId,new Date().toISOString().slice(0,7));
  const call=vi.spyOn(getProvider('groq')!,'chatCompletion').mockResolvedValue(answer);
  expect((await post('/api/models/'+ids[0]+'/test')).body.success).toBe(false);
  expect(call).not.toHaveBeenCalled();
  expect(getMonthlyUsage(keyId)).toEqual({requests:1,tokens:10});
});
it('records successful test usage in monthly accounting and request history', async () => {
  vi.spyOn(getProvider('groq')!,'chatCompletion').mockResolvedValue(answer);
  expect((await post('/api/models/'+ids[0]+'/test')).body.success).toBe(true);
  expect(getMonthlyUsage(keyId)).toEqual({requests:1,tokens:5});
  const logged=getDb().prepare("SELECT caller,input_tokens,output_tokens FROM requests WHERE key_id=?").get(keyId);
  expect(logged).toEqual({caller:'model-test',input_tokens:3,output_tokens:2});
  expect(checkMonthlyBudget(keyId,0).allowed).toBe(false);
});
it('reserves capacity across models while a test is in flight and releases it after failure', async () => {
  let reject!: (error: Error)=>void;
  let started!: ()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const call=vi.spyOn(getProvider('groq')!,'chatCompletion').mockImplementationOnce(()=>{started();return new Promise((_resolve,r)=>{reject=r;});});
  const first=post('/api/models/'+ids[0]+'/test'); await began;
  expect(checkMonthlyBudget(keyId,0).allowed).toBe(false);
  expect((await post('/api/models/'+ids[1]+'/test')).body.success).toBe(false);
  expect(call).toHaveBeenCalledTimes(1);
  reject(new Error('synthetic upstream failure'));
  expect((await first).body.success).toBe(false);
  expect(checkMonthlyBudget(keyId,20).allowed).toBe(true);
  expect(getMonthlyUsage(keyId)).toEqual({requests:0,tokens:0});
});
it('rejects a test whose input/output reservation would exceed the token cap', async () => {
  getDb().prepare('UPDATE api_keys SET monthly_token_cap=10 WHERE id=?').run(keyId);
  const call=vi.spyOn(getProvider('groq')!,'chatCompletion').mockResolvedValue(answer);
  expect((await post('/api/models/'+ids[0]+'/test')).body.success).toBe(false);
  expect(call).not.toHaveBeenCalled();
});
it('requires an existing custom key and rejects mismatched endpoints or native key bindings', async () => {
  const payload={platform:'custom',modelId:'new-model'};
  expect((await post('/api/models',payload)).status).toBe(400);
  expect((await post('/api/models',{...payload,keyId})).status).toBe(400);
  expect((await post('/api/models',{platform:'groq',modelId:'native-bound',keyId})).status).toBe(400);
  getDb().prepare("UPDATE api_keys SET platform='custom',base_url='https://relay-a.example/v1' WHERE id=?").run(keyId);
  expect((await post('/api/models',{...payload,keyId,endpointScope:'https://relay-b.example/v1'})).status).toBe(400);
  const added=await post('/api/models',{...payload,keyId});
  expect(added.status).toBe(201);
  expect(getDb().prepare('SELECT key_id,endpoint_scope FROM models WHERE id=?').get(added.body.id)).toEqual({key_id:keyId,endpoint_scope:'https://relay-a.example/v1'});
});
