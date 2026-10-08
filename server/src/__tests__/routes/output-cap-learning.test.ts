import { it, expect, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resetLearnedOutputCaps } from '../../lib/output-cap.js';
import { getProvider } from '../../providers/index.js';
import { setRoutingStrategy } from '../../services/router.js';

// Claude Code sends max_tokens 128000. A model whose output ceiling is lower
// rejects it with a 400; the gateway must learn the ceiling, retry that model
// with max_tokens clamped, and keep clamping later requests, instead of
// benching it or booking it as a model without tool support.
it('/v1/messages learns an output ceiling from a max_tokens rejection and clamps later requests', async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:'); const db = getDb(); setRoutingStrategy('priority'); resetLearnedOutputCaps();
  db.prepare('UPDATE models SET enabled = 0').run();
  db.prepare('DELETE FROM profile_models').run();
  for (const index of [0, 1]) {
    const id = Number(db.prepare("INSERT INTO models(platform,model_id,display_name,intelligence_rank,speed_rank,size_label,context_window,enabled,supports_tools) VALUES ('groq',?,?,1,1,'Large',262144,1,1)")
      .run('cap-test-' + index, 'Cap test ' + index).lastInsertRowid);
    db.prepare('INSERT INTO profile_models(profile_id,model_db_id,priority,enabled) SELECT id,?,?,1 FROM profiles').run(id, index);
  }
  const { encrypted, iv, authTag } = encrypt('synthetic-key');
  db.prepare("INSERT INTO api_keys(platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('groq','test',?,?,?,'healthy',1)").run(encrypted, iv, authTag);
  const calls: { model: string; budget?: number }[] = [];
  const spy = vi.spyOn(getProvider('groq')!, 'chatCompletion').mockImplementation(async (_key, _messages, model, options) => {
    calls.push({ model, budget: options?.contextBudget });
    if (model === 'cap-test-0' && (options?.contextBudget ?? Infinity) > 65536) {
      throw Object.assign(new Error('Groq API error 400: `max_tokens` must be less than or equal to `65536`, the maximum value for `max_tokens` is less than the `context_window` for this model'), { status: 400 });
    }
    return { id: 'test', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
  });
  const server = createApp().listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(r => server.once('listening', r));
  const send = (text: string) => fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': getUnifiedApiKey(), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-5', max_tokens: 128000,
      messages: [{ role: 'user', content: text }],
      tools: [{ name: 'noop', description: 'does nothing', input_schema: { type: 'object', properties: {} } }],
    }),
  });
  try {
    const first = await send('first request');
    expect(first.status).toBe(200);
    // Learned on the first rejection, then the same model retried, clamped.
    expect(calls.map(c => c.model)).toEqual(['cap-test-0', 'cap-test-0']);
    expect(calls[1].budget).toBe(65536);

    calls.length = 0;
    const second = await send('a different second request');
    expect(second.status).toBe(200);
    // Not benched: the priority-0 model is tried first again, now clamped.
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('cap-test-0');
    expect(calls[0].budget).toBe(65536);
  } finally { server.close(); spy.mockRestore(); }
});
