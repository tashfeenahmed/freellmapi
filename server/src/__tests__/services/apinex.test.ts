import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runDecision, DECISION_PLATFORMS } from '../../services/decision.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { applyCatalog, catalogShapeProblems } from '../../services/catalog-sync.js';
import { ApinexProvider } from '../../providers/apinex.js';

const model = 'free/jev-1.13';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const request = { state: 'Invoice charged twice', questions: {
  billing: { type: 'noul' as const, instructions: 'Billing issue?' },
  route: { type: 'choice' as const, instructions: 'Choose a queue', criteria: { billing: 'Invoice questions', technical: 'Software issues' } },
  urgency: { type: 'score' as const, instructions: 'Rate urgency', criteria: { low: 'Routine question', high: 'Urgent' } },
} };
const answers = { billing: { type: 'noul', noul: 0.99 }, route: { type: 'choice', choice: 'billing', confidence: 1 }, urgency: { type: 'score', score: 0.5 } };
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });
function seed() {
  const key = encrypt('unit-test-key');
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('apinex','test',?,?,?,'healthy',1)").run(key.encrypted, key.iv, key.authTag);
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES ('apinex',?,?,'decision',0,1,'Shared daily quota')").run(model, model);
}

describe('APINex decisions', () => {
  it('dispatches typed questions to /decisions with the exact free route', async () => {
    seed();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model, answers, usage: { input_tokens: 335, output_tokens: 47 } }));
    expect(DECISION_PLATFORMS.has('apinex')).toBe(true);
    expect(await runDecision(request, { model })).toEqual({ provider: 'apinex', model, answers, usage: { input_tokens: 335, output_tokens: 47 } });
    expect(fetch.mock.calls[0][0]).toBe('https://api.apinex.bond/v1/decisions');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, ...request });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer unit-test-key');
    expect(fetch.mock.calls[0][1]?.redirect).toBe('error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, { model: 'jev-1.13', answers }, { answers }, { model, answers: {} },
    { model, answers: { ...answers, billing: { type: 'noul', noul: 'yes' } } },
    { model, answers: { ...answers, route: { type: 'choice', choice: 1 } } },
    { model, answers: { ...answers, urgency: { type: 'score', score: null } } },
    { model, answers, error: { message: 'Upstream failed' } },
  ])('fails closed on malformed, missing, or substituted answers', async body => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runDecision(request, { model })).rejects.toMatchObject({ status: 502 });
  });

  it.each([401, 402, 429, 503])('uses existing failure policy for HTTP %s, with no paid-alias retry', async status => {
    seed();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: { retry_after_seconds: 45 } }, status));
    const error = await runDecision(request, { model }).catch(error => error);
    expect(error).toMatchObject({ status: status === 429 ? 429 : 502, retryAfterMs: status === 429 ? 45_000 : undefined });
    expect(error.message).toContain(`apinex ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps chat and decision rows distinct, catalog-only, and idempotent', () => {
    const db = getDb(), premiumSince = '2026-10-18T12:00:00.000Z';
    expect(db.prepare("SELECT COUNT(*) n FROM models WHERE platform='apinex'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM media_models WHERE platform='apinex'").get()).toEqual({ n: 0 });
    const catalog = { version: '2099.01.01', generatedAt: premiumSince, tier: 'live' as const, quirks: [],
      models: [{ platform: 'apinex', modelId: 'free/glm-5.3', displayName: 'GLM 5.3', intelligenceRank: 50, speedRank: 50, sizeLabel: '', limits: { rpm: 5, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Shared daily weighted allowance', contextWindow: 1000000, enabled: true, supportsTools: true, supportsVision: false, premiumSince }],
      decisionModels: [{ platform: 'apinex', modelId: model, displayName: 'JEV 1.13', priority: 10, enabled: true, quotaLabel: 'Shared daily weighted allowance', contextWindow: 65536, premiumSince }],
    };
    expect(catalogShapeProblems(catalog)).toEqual([]);
    expect(applyCatalog(db, catalog).skippedUnknownPlatform).toBe(0);
    expect(applyCatalog(db, catalog).inserted).toBe(0);
    expect(db.prepare("SELECT model_id FROM models WHERE platform='apinex'").all()).toEqual([{ model_id: 'free/glm-5.3' }]);
    const row = db.prepare("SELECT model_id,modality,meta_json FROM media_models WHERE platform='apinex'").get() as { model_id: string; modality: string; meta_json: string };
    expect(row.model_id).toBe(model); expect(row.modality).toBe('decision');
    expect(JSON.parse(row.meta_json).premiumSince).toBe(premiumSince);
  });
});

describe('APINex response guards', () => {
  it.each([{ balance_usd: 0 }, { object: 'balance', balance_usd: '0' }, { object: 'balance', balance_usd: 0, error: 'failed' }])('rejects malformed account metadata', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(new ApinexProvider().validateKey('test')).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ error: { message: 'Upstream failed' } }, { model: 'free/glm-5.3' }])('rejects malformed SSE after a valid first event', async event => {
    const first = { id: 's', object: 'chat.completion.chunk', model: 'free/glm-5.3', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response([first, event].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'));
    const collect = async () => { for await (const _ of new ApinexProvider().streamChatCompletion('test', [], 'free/glm-5.3')) { /* drain */ } };
    await expect(collect()).rejects.toMatchObject({ status: 502 });
  });
  it('rejects a stream with no identified completion', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('data: [DONE]\n\n'));
    await expect(new ApinexProvider().streamChatCompletion('test', [], 'free/glm-5.3').next()).rejects.toMatchObject({ status: 502 });
  });
});
