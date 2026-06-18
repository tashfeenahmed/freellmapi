import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

describe('Proxy Keyed Model Preference', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();
  });

  it('prefers a platform with configured keys when multiple platforms host the same model_id', async () => {
    const db = getDb();

    // 1. Insert two duplicate models with different platforms:
    // Model A: platform 'openrouter', model_id 'duplicate-model-test'
    // Model B: platform 'kilo', model_id 'duplicate-model-test'
    db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, supports_vision, supports_tools, context_window
      ) VALUES (
        'openrouter', 'duplicate-model-test', 'Duplicate Model OpenRouter', 1, 1, 'Medium', 1,
        null, null, null, null, 0, 1, 8192
      )
    `).run();

    const openRouterModel = db.prepare("SELECT id FROM models WHERE platform = 'openrouter' AND model_id = 'duplicate-model-test'").get() as { id: number };

    db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, supports_vision, supports_tools, context_window
      ) VALUES (
        'kilo', 'duplicate-model-test', 'Duplicate Model Kilo', 1, 1, 'Medium', 1,
        null, null, null, null, 0, 1, 8192
      )
    `).run();

    const kiloModel = db.prepare("SELECT id FROM models WHERE platform = 'kilo' AND model_id = 'duplicate-model-test'").get() as { id: number };

    // 2. Add both to fallback config
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(openRouterModel.id);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(kiloModel.id);

    // 3. Add an API key for 'kilo' only (none for 'openrouter')
    const { encrypted, iv, authTag } = encrypt('kilo-api-key-test');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('kilo', 'Kilo test key', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);

    // 4. Mock the fetch call to succeed for Kilo completions
    const origFetch = global.fetch;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.kilo.ai/api/gateway/v1/chat/completions')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 123,
            model: 'duplicate-model-test',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'routed via kilo' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });

    // 5. Send request with model: 'duplicate-model-test'
    const { status, body } = await post(app, '/v1/chat/completions', {
      model: 'duplicate-model-test',
      messages: [{ role: 'user', content: 'hello' }],
    }, key);

    // 6. Verify that it was successfully routed to Kilo
    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('routed via kilo');
    
    // Check that requests table logged the kilo platform
    const loggedRequest = db.prepare("SELECT platform, model_id FROM requests ORDER BY id DESC LIMIT 1").get() as { platform: string, model_id: string };
    expect(loggedRequest.platform).toBe('kilo');
    expect(loggedRequest.model_id).toBe('duplicate-model-test');

    fetchSpy.mockRestore();
  });
});
