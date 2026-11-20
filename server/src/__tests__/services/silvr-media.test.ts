import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runEmbeddings, EMBEDDING_PLATFORMS } from '../../services/embeddings.js';
import { runTranscription, TRANSCRIPTION_PLATFORMS } from '../../services/media.js';
import { runDecision, CATALOG_DECISION_PLATFORMS } from '../../services/decision.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';
import { clearAllCooldowns, isOnCooldown } from '../../services/ratelimit.js';

const model = 'gemini-decision-1';
const request = { state: 'The mug arrived broken.', questions: { damaged: { type: 'noul' as const, instructions: 'Is the mug damaged?' } } };
const answer = { name: 'damaged', type: 'predicate', probability: 0.99 };
const response = () => ({ model, answers: [answer], usage: { input_tokens: 20, output_tokens: 0 } });
let keyId: number;
function seed(modelId: string, modality: string) {
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES ('silvr',?,?,?,1,1)").run(modelId, modelId, modality);
}
function embedding(modelId = 'text-embedding-3-small', dimensions = 1536) {
  getDb().prepare("INSERT INTO embedding_models (platform,model_id,display_name,family,dimensions,priority,enabled,quota_label) VALUES ('silvr',?,?,'test-family',?,1,1,'shared daily')").run(modelId, modelId, dimensions);
}
const transcription = { file: Buffer.from('synthetic upload'), filename: 'speech.wav', responseFormat: 'json', language: 'en' };
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  const e = encrypt('silvr-synthetic-key');
  keyId = Number(getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('silvr','test',?,?,?,'healthy',1)").run(e.encrypted, e.iv, e.authTag).lastInsertRowid);
});
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('SilvR renewable media routes', () => {
  it('shares one allowance across chat, embeddings, transcription and decisions', () => {
    expect(new Set(['glm-5-3', 'gemini-embedding-2', 'whisper-large-v3-turbo', model].map(m => inferPoolForPlatform('silvr', m))).size).toBe(1);
    expect(EMBEDDING_PLATFORMS.has('silvr')).toBe(true);
    expect(TRANSCRIPTION_PLATFORMS.has('silvr')).toBe(true);
    expect(CATALOG_DECISION_PLATFORMS.has('silvr')).toBe(true);
  });
  it.each([['nemotron-3-5-embed-1b', 2048], ['nemotron-3-5-embed-8b', 4096], ['gemini-embedding-2', 3072], ['gemini-embedding-001', 3072], ['text-embedding-3-small', 1536]] as const)('routes %s with exact native dimensions and sorted input order', async (id, dimensions) => {
    embedding(id, dimensions);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ model: id, data: [{ index: 1, embedding: Array(dimensions).fill(0.2) }, { index: 0, embedding: Array(dimensions).fill(0.1) }], usage: { prompt_tokens: 4 } }));
    expect(await runEmbeddings('test-family', ['one', 'two'])).toMatchObject({ platform: 'silvr', modelId: id, dimensions, inputTokens: 4 });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.silvrai.net/v1/embeddings'); expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer silvr-synthetic-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model: id, input: ['one', 'two'] });
  });
  it.each([null, { model: 'wrong', data: [] }, { model: 'text-embedding-3-small', data: {} },
    { model: 'text-embedding-3-small', data: [null] },
    { model: 'text-embedding-3-small', data: [{ index: 0, embedding: Array(1536).fill(0) }] },
    { model: 'text-embedding-3-small', data: [{ index: 0, embedding: [0.1] }] },
    { model: 'text-embedding-3-small', data: [{ index: 1, embedding: Array(1536).fill(0.1) }] },
  ])('rejects substituted or malformed embeddings %j', async body => {
    embedding(); vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(body));
    await expect(runEmbeddings('test-family', ['one'])).rejects.toMatchObject({ status: 502 });
  });
  it('rejects untested dimension overrides before spending credits', async () => {
    embedding(); const fetch = vi.spyOn(global, 'fetch');
    await expect(runEmbeddings('test-family', ['one'], 256)).rejects.toThrow('native dimensions'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['whisper-large-v3-turbo', 'whisper-large-v3'])('uploads %s multipart without claiming native subtitle support', async modelId => {
    seed(modelId, 'transcription');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ model: modelId, text: 'Hello', duration: 1 }));
    expect(await runTranscription(modelId, transcription)).toMatchObject({ platform: 'silvr', modelId, text: 'Hello', duration: 1 });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.silvrai.net/v1/audio/transcriptions'); expect(init?.redirect).toBe('error');
    const form = init?.body as FormData; expect(form.get('model')).toBe(modelId); expect(form.get('response_format')).toBe('json'); expect(form.get('language')).toBe('en');
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(transcription.file);
  });
  it('rejects untested transcription routes without spending the shared allowance', async () => {
    seed('whisper-1', 'transcription'); const fetch = vi.spyOn(global, 'fetch');
    await expect(runTranscription('whisper-1', transcription)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, { text: 5 }, { text: 'Hi', error: 'failed' }, { text: 'Hi', model: 'substituted' }, { text: 'Hi', duration: -1 }])('rejects invalid transcription success %j', async body => {
    seed('whisper-large-v3-turbo', 'transcription'); vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(body));
    await expect(runTranscription('whisper-large-v3-turbo', transcription)).rejects.toMatchObject({ status: 502 });
  });
  it('maps a System One predicate to the tested named question array and validates usage', async () => {
    seed(model, 'decision'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(response()));
    expect(await runDecision(request, { model })).toMatchObject({ provider: 'silvr', model, answers: { damaged: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 20, output_tokens: 0 } });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.silvrai.net/v1/decisions'); expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ model, input: request.state, questions: [{ name: 'damaged', type: 'predicate', instructions: 'Is the mug damaged?' }] });
  });
  it.each(['choice', 'score'] as const)('rejects untested %s decisions without an upstream call', async type => {
    seed(model, 'decision'); const fetch = vi.spyOn(global, 'fetch');
    await expect(runDecision({ ...request, questions: { damaged: { ...request.questions.damaged, type } } }, { model })).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([null, { ...response(), model: 'substituted' }, { ...response(), answers: [] }, { ...response(), answers: [answer, answer] },
    { ...response(), answers: [{ ...answer, name: 'unknown' }] }, { ...response(), answers: [{ ...answer, probability: 1.2 }] },
    { ...response(), answers: [{ ...answer, probability: null }] }, { ...response(), usage: { input_tokens: -1, output_tokens: 0 } },
  ])('rejects invalid decision success %j', async body => {
    seed(model, 'decision'); vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(body));
    await expect(runDecision(request, { model })).rejects.toMatchObject({ status: 502 });
  });
  it.each(['embedding', 'transcription', 'decision'])('preserves 429/backoff and redacts error bodies for %s', async type => {
    embedding(); seed(model, 'decision'); seed('whisper-large-v3-turbo', 'transcription');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('echoed-secret', { status: 429, headers: { 'Retry-After': '45' } }));
    const result = type === 'embedding' ? runEmbeddings('test-family', ['one']) : type === 'decision' ? runDecision(request, { model }) : runTranscription('whisper-large-v3-turbo', transcription);
    const error = await result.catch(e => e); expect(error).toMatchObject({ status: 429, retryAfterMs: 45000 }); expect(error.message).not.toContain('echoed-secret');
    if (type !== 'embedding') expect(isOnCooldown('silvr', type === 'decision' ? model : 'whisper-large-v3-turbo', keyId)).toBe(true);
  });
});
