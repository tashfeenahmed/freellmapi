import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runImageGeneration } from '../../services/media.js';
import { runDecision } from '../../services/decision.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });
function seed(platform: string, model: string, modality: string) {
  const key = encrypt('unit-test-key');
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES (?,'test',?,?,?,'healthy',1)").run(platform, key.encrypted, key.iv, key.authTag);
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES (?,?,?,?,1,1,'shared free allowance')").run(platform, model, model, modality);
}

describe('Plugsky images', () => {
  it.each(['plugsky-flux', 'dall-e-3'])('uses the tested base64 image route %s', async model => {
    seed('plugsky', model, 'image');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    expect(await runImageGeneration(model, { prompt: 'blue circle' })).toEqual({ platform: 'plugsky', modelId: model, images: [{ b64_json: 'aW1hZ2U=' }] });
    expect(fetch.mock.calls[0][0]).toBe('https://plugsky.com/v1/images/generations');
    const init = fetch.mock.calls[0][1];
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer unit-test-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model, prompt: 'blue circle', n: 1, response_format: 'b64_json' });
  });
  it.each([null, {}, { data: [] }, { data: [null] }, { data: [{ b64_json: '' }] }, { data: [{ url: 'https://example.com/image' }] }])('rejects malformed images %j', async body => {
    seed('plugsky', 'plugsky-flux', 'image');
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runImageGeneration('plugsky-flux', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
  });
  it('preserves quota errors and never retries a paid alias', async () => {
    seed('plugsky', 'plugsky-flux', 'image');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({}, 429, { 'Retry-After': '30' }));
    await expect(runImageGeneration('plugsky-flux', { prompt: 'circle' })).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

const request = { state: { message: 'Please fix my code urgently. I am angry.' }, questions: {
  urgent: { type: 'noul' as const, instructions: 'Is this urgent?' },
  team: { type: 'choice' as const, instructions: 'Team?', criteria: { code: 'Coding', chat: null } },
  mood: { type: 'score' as const, instructions: 'Anger?', criteria: ['calm', 'angry'] },
} };
const response = () => ({ model: 'gpt-6-luna', answers: [
  { type: 'predicate', name: 'urgent', probability: 0.9 },
  { type: 'choice', name: 'team', choice: 'code', probabilities: [{ value: 'code', probability: 1 }, { value: 'chat', probability: 0 }], confidence: 1 },
  { type: 'score', name: 'mood', score: 0.9, probabilities: [{ value: 0, probability: 0.1 }, { value: 1, probability: 0.9 }], confidence: 0.8 },
], usage: { input_tokens: 10, output_tokens: 0 } });
describe('BlockRun decisions', () => {
  beforeEach(() => seed('blockrun', 'gpt-6-luna', 'decision'));
  it('translates the full request and all three typed answers without using chat', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(response()));
    const result = await runDecision(request, { model: 'gpt-6-luna', clientAgent: null });
    expect(result).toEqual({ model: 'gpt-6-luna', provider: 'blockrun', answers: {
      urgent: { type: 'noul', noul: 0.9 },
      team: { type: 'choice', choice: 'code', probabilities: { code: 1, chat: 0 }, confidence: 1 },
      mood: { type: 'score', score: 0.9, probabilities: { 0: 0.1, 1: 0.9 }, confidence: 0.8 },
    }, usage: { input_tokens: 10, output_tokens: 0 } });
    expect(fetch.mock.calls[0][0]).toBe('https://api.blockrun.ai/v1/decisions');
    const init = fetch.mock.calls[0][1];
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer unit-test-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'gpt-6-luna', input: JSON.stringify(request.state), questions: [
      { name: 'urgent', type: 'predicate', instructions: 'Is this urgent?' },
      { name: 'team', type: 'choice', instructions: 'Team?', choices: [{ value: 'code', description: 'Coding' }, { value: 'chat', description: 'chat' }] },
      { name: 'mood', type: 'score', instructions: 'Anger?', levels: [{ label: '0', description: 'calm' }, { label: '1', description: 'angry' }] },
    ] });
    expect(getDb().prepare('SELECT platform,status,input_tokens FROM decision_requests').get()).toEqual({ platform: 'blockrun', status: 'ok', input_tokens: 10 });
  });
  it.each([null, {}, { ...response(), model: 'another-model' }, { ...response(), answers: [] },
    { ...response(), answers: [...response().answers, response().answers[0]] },
    { ...response(), answers: [{ name: 'urgent', type: 'refusal' }] },
    { ...response(), answers: [{ name: 'urgent', type: 'predicate', probability: 2 }] },
  ])('rejects malformed, substituted, missing or refused judgments %j', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runDecision(request, { model: 'gpt-6-luna', clientAgent: null })).rejects.toMatchObject({ status: 502 });
  });
  it('keeps retry-after for decision failover', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json({}, 429, { 'Retry-After': '40' }));
    await expect(runDecision(request, { model: 'gpt-6-luna', clientAgent: null })).rejects.toMatchObject({ status: 429, retryAfterMs: 40_000 });
  });
});

it('loads the new models only from the catalog and separates modalities', () => {
  const model = { intelligenceRank: 50, speedRank: 10, sizeLabel: '', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Shared', contextWindow: null, enabled: true, supportsVision: false, supportsTools: false };
  const catalog = { version: '2099.01.01', generatedAt: '2099-01-01T00:00:00Z', tier: 'live' as const, quirks: [], models: [
    { ...model, platform: 'kiosapi', modelId: 'meta/llama-3.1-8b', displayName: 'Llama' },
    { ...model, platform: 'plugsky', modelId: 'dall-e-3', displayName: 'FLUX Dev (compatibility alias)', modality: 'image' as const },
  ], decisionModels: [{ platform: 'blockrun', modelId: 'gpt-6-luna', displayName: 'GPT-6 Luna Decisions', priority: 1, enabled: true }] };
  expect(applyCatalog(getDb(), catalog).skippedUnknownPlatform).toBe(0);
  expect(applyCatalog(getDb(), catalog).inserted).toBe(0);
  expect(getDb().prepare("SELECT model_id FROM models WHERE platform IN ('kiosapi','blockrun','plugsky')").all()).toEqual([{ model_id: 'meta/llama-3.1-8b' }]);
  expect(getDb().prepare("SELECT model_id,modality FROM media_models WHERE platform IN ('plugsky','blockrun') ORDER BY platform").all()).toEqual([{ model_id: 'gpt-6-luna', modality: 'decision' }, { model_id: 'dall-e-3', modality: 'image' }]);
});
