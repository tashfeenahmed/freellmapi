import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { encrypt } from '../../lib/crypto.js';
import { getDb, getUnifiedApiKey, initDb, setSetting } from '../../db/index.js';
import { isOnCooldown } from '../../services/ratelimit.js';
import { resetCloudflareNeuronMeter } from '../../services/cloudflare-neurons.js';

// A Cloudflare call too big for what is left of the day's neuron cap is
// refused by the meter before anything goes out. That refusal must fail over
// to the next provider invisibly (the client still gets an answer), must not
// bench the Cloudflare account, and must not be charged.

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getUnifiedApiKey()}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  return { status: res.status, headers: res.headers, text };
}

const GLM = '@cf/zai-org/glm-4.7-flash';
const CF_KEY = 'account-a:cf-token';

function addKey(platform: string, raw: string): number {
  const k = encrypt(raw);
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 't', ?, ?, ?, 'healthy', 1)
  `).run(platform, k.encrypted, k.iv, k.authTag).lastInsertRowid);
}

const reply = {
  id: 'x', object: 'chat.completion', created: 1, model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok from groq' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

describe('Cloudflare neuron meter refusal fails over', () => {
  let app: Express;
  let cloudflareCalls = 0;
  const savedCap = process.env.CLOUDFLARE_DAILY_NEURON_CAP;
  const savedAnalytics = process.env.CLOUDFLARE_NEURON_ANALYTICS;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  beforeEach(() => {
    for (const t of ['api_keys', 'requests', 'rate_limit_usage', 'rate_limit_cooldowns', 'cloudflare_neuron_usage']) {
      getDb().prepare(`DELETE FROM ${t}`).run();
    }
    resetCloudflareNeuronMeter();
    process.env.CLOUDFLARE_NEURON_ANALYTICS = '0';
    // Room left (0 used) for a small GLM 4.7 Flash call (~37 neurons), but
    // less than a default max_tokens 8192 call reserves (~298).
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '200';
    // GLM 4.7 Flash is the only Cloudflare model left, ranked first.
    getDb().prepare("UPDATE models SET enabled = 0 WHERE platform = 'cloudflare' AND model_id <> ?").run(GLM);
    // ...and one Groq model that the default order ranks after it.
    getDb().prepare("UPDATE models SET enabled = 1 WHERE platform = 'groq'").run();
    getDb().prepare("UPDATE models SET enabled = 0 WHERE platform = 'groq' AND model_id <> 'groq/compound-mini'").run();
    // Plain priority order, no exploration: Cloudflare is tried first every run.
    setSetting('routing_strategy', 'priority');
    setSetting('routing_explore_enabled', '0');
    cloudflareCalls = 0;
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('api.cloudflare.com')) {
        cloudflareCalls++;
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('api.groq.com')) {
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedCap === undefined) delete process.env.CLOUDFLARE_DAILY_NEURON_CAP;
    else process.env.CLOUDFLARE_DAILY_NEURON_CAP = savedCap;
    if (savedAnalytics === undefined) delete process.env.CLOUDFLARE_NEURON_ANALYTICS;
    else process.env.CLOUDFLARE_NEURON_ANALYTICS = savedAnalytics;
  });

  it('a Cloudflare call that does not fit is skipped, the request is served elsewhere, no bench, no charge', async () => {
    const cf = addKey('cloudflare', CF_KEY);
    addKey('groq', 'gsk_neuron_failover');
    const { status, text, headers } = await post(app, '/v1/chat/completions', {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(status, text).toBe(200);
    expect(JSON.parse(text).choices[0].message.content).toBe('ok from groq');
    expect(cloudflareCalls).toBe(0);
    // The refusal is about this request: the account stays routable.
    expect(isOnCooldown('cloudflare', GLM, cf)).toBe(false);
    const charged = getDb().prepare('SELECT COALESCE(SUM(neurons), 0) AS n FROM cloudflare_neuron_usage').get() as { n: number };
    expect(charged.n).toBe(0);
    // Cloudflare was tried first (and refused) so this is not vacuous.
    expect(headers.get('x-fallback-trail') ?? '').toMatch(/cloudflare/i);
  });
});
