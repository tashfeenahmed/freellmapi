import { it, expect, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getProvider } from '../../providers/index.js';
import { setRoutingStrategy } from '../../services/router.js';

it('chat completions skips a too-small fallback after a provider reports request size', async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:'); const db = getDb(); setRoutingStrategy('priority');
  db.prepare('UPDATE models SET enabled = 0').run();
  db.prepare('DELETE FROM profile_models').run();
  for (const [index, window] of [50000, 24000, 50000].entries()) {
    const id = Number(db.prepare("INSERT INTO models(platform,model_id,display_name,intelligence_rank,speed_rank,size_label,context_window,enabled,supports_tools) VALUES ('groq',?,?,1,1,'Small',?,1,1)")
      .run('size-test-' + index, 'Size test ' + index, window).lastInsertRowid);
    db.prepare('INSERT INTO profile_models(profile_id,model_db_id,priority,enabled) SELECT id,?,?,1 FROM profiles').run(id,index);
  }
  const {encrypted,iv,authTag} = encrypt('synthetic-key');
  db.prepare("INSERT INTO api_keys(platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('groq','test',?,?,?,'healthy',1)").run(encrypted,iv,authTag);
  const called: string[] = [];
  const spy = vi.spyOn(getProvider('groq')!, 'chatCompletion').mockImplementation(async (_key, _messages, model) => {
    called.push(model);
    if (model === 'size-test-0') throw Object.assign(new Error('Groq API error 413: Limit 8000, Requested 30000, please reduce your message size'), {status:413});
    return {id:'test',object:'chat.completion',created:1,model,choices:[{index:0,message:{role:'assistant',content:'hello'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}};
  });
  const server = createApp().listen(0,'127.0.0.1');
  if (!server.listening) await new Promise<void>(r => server.once('listening',r));
  try {
    const res = await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1/chat/completions', {
      method:'POST', headers:{Authorization:'Bearer '+getUnifiedApiKey(),'Content-Type':'application/json'},
      body:JSON.stringify({model:'auto',messages:[{role:'user',content:'hello'}],max_tokens:256}),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(called).toEqual(['size-test-0','size-test-2']);
  } finally {server.close(); spy.mockRestore();}
});
