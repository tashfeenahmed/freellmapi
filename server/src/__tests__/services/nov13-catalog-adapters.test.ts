import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { runEmbeddings } from '../../services/embeddings.js';
import { CATALOG_DECISION_PLATFORMS, runDecision } from '../../services/decision.js';
import { runTranscription, TRANSCRIPTION_PLATFORMS } from '../../services/media.js';
import { neuronsFor, resetCloudflareNeuronMeter } from '../../services/cloudflare-neurons.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';

const EMBED = '@cf/google/embeddinggemma-2';
const QUESTION = { state: 'The mug arrived cracked.', questions: { damaged: { type: 'noul' as const, instructions: 'Did the item arrive damaged?' } } };
const ANSWER = { damaged: { type: 'noul', noul: 0.98, confidence: 0.98 } };
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function addKey(platform: string, value = `${platform}-test-key`) {
  const secret = encrypt(value);
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES (?,'test',?,?,?,'healthy',1)")
    .run(platform, secret.encrypted, secret.iv, secret.authTag);
}
function seedDecision(model = 'gemini-decision-1') {
  addKey('google');
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES ('google',?,?,'decision',1,1,'free')").run(model, model);
}
function seedEmbed() {
  addKey('cloudflare', 'test-account:test-token');
  getDb().prepare("INSERT INTO embedding_models (family,platform,model_id,display_name,dimensions,priority,enabled,quota_label) VALUES ('embeddinggemma-2','cloudflare',?,'EmbeddingGemma 2',768,1,1,'free')").run(EMBED);
}
const vectors = () => ({ success: true, errors: [], result: { model: EMBED,
  data: [{ index: 1, embedding: Array(768).fill(0.2) }, { index: 0, embedding: Array(768).fill(0.1) }], usage: { prompt_tokens: 26 } } });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  process.env.CLOUDFLARE_NEURON_ANALYTICS = '0';
  initDb(':memory:'); clearAllCooldowns(); resetCloudflareNeuronMeter();
});
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('native Cloudflare EmbeddingGemma 2', () => {
  it('keeps batch ordering, fixed dimensions, identity and native token usage', async () => {
    seedEmbed(); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(response(vectors()));
    const out = await runEmbeddings('embeddinggemma-2', ['first', 'second']);
    expect(out).toMatchObject({ modelId: EMBED, dimensions: 768, inputTokens: 26 });
    expect(out.vectors.map(v => v[0])).toEqual([0.1, 0.2]);
    expect(fetch.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/' + EMBED);
    const init = fetch.mock.calls[0][1]!;
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-token');
    expect(JSON.parse(String(init.body))).toEqual({ input: ['first', 'second'] });
    expect(neuronsFor(EMBED, { inputTokens: 1_000_000 })).toBeCloseTo(154.54545, 3);
  });
  it.each([
    { success: true, result: { model: 'other', data: [] } },
    { success: false, result: vectors().result },
    { errors: [{ message: 'upstream failure' }], result: vectors().result },
    { result: { ...vectors().result, data: [{ index: 0, embedding: [0.1] }] } },
    { result: { ...vectors().result, data: [{ index: 0, embedding: Array(768).fill(null) }] } },
    { result: { ...vectors().result, data: [{ index: 0, embedding: Array(768).fill('0.1') }] } },
    { result: { ...vectors().result, data: [{ embedding: Array(768).fill(0.1) }] } },
    { result: { ...vectors().result, data: [{ index: 0, embedding: Array(768).fill(0.1) }, { index: 0, embedding: Array(768).fill(0.2) }] } },
  ])('rejects malformed responses without switching embedding families', async body => {
    seedEmbed(); vi.spyOn(global, 'fetch').mockResolvedValue(response(body));
    await expect(runEmbeddings('embeddinggemma-2', ['first', 'second'])).rejects.toMatchObject({ status: 502 });
  });
  it('rejects unsupported dimension overrides before a request', async () => {
    seedEmbed(); const fetch = vi.spyOn(global, 'fetch');
    await expect(runEmbeddings('embeddinggemma-2', ['hello'], 256)).rejects.toThrow(/768 dimensions/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves upstream cooldown hints', async () => {
    seedEmbed(); vi.spyOn(global, 'fetch').mockResolvedValue(response({}, 429, { 'Retry-After': '23' }));
    await expect(runEmbeddings('embeddinggemma-2', ['hello'])).rejects.toMatchObject({ status: 429, retryAfterMs: 23000 });
  });
});

describe('native Google decisions', () => {
  it('maps state to input, sends header auth, validates answers and records real usage', async () => {
    seedDecision(); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(response({ answers: ANSWER, usage: { total_input_tokens: 94, total_output_tokens: 0 } }));
    expect(CATALOG_DECISION_PLATFORMS.has('google')).toBe(true);
    expect(await runDecision(QUESTION, { model: 'gemini-decision-1' })).toMatchObject({ provider: 'google', answers: ANSWER, usage: { input_tokens: 94, output_tokens: 0 } });
    expect(fetch.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
    const init = fetch.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('google-test-key');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'gemini-decision-1', input: QUESTION.state, questions: QUESTION.questions });
  });
  it.each([
    { model: 'other', answers: ANSWER, usage: { total_input_tokens: 1, total_output_tokens: 0 } },
    { answers: {}, usage: { total_input_tokens: 1, total_output_tokens: 0 } },
    { answers: { damaged: { type: 'noul', noul: 2, confidence: 0.5 } }, usage: { total_input_tokens: 1, total_output_tokens: 0 } },
    { answers: { damaged: { type: 'noul', noul: 0.5, confidence: 2 } }, usage: { total_input_tokens: 1, total_output_tokens: 0 } },
    { answers: ANSWER, usage: { total_input_tokens: -1, total_output_tokens: 0 } },
    { answers: ANSWER, usage: { total_input_tokens: 1, total_output_tokens: 1 } },
    { answers: ANSWER }, { error: 'upstream error' },
  ])('fails closed on invalid typed results and usage', async body => {
    seedDecision(); vi.spyOn(global, 'fetch').mockResolvedValue(response(body));
    await expect(runDecision(QUESTION, { model: 'gemini-decision-1' })).rejects.toMatchObject({ status: 502 });
  });
  it('preserves rate-limit hints', async () => {
    seedDecision(); vi.spyOn(global, 'fetch').mockResolvedValue(response({ error: 'quota' }, 429, { 'Retry-After': '31' }));
    await expect(runDecision(QUESTION, { model: 'gemini-decision-1' })).rejects.toMatchObject({ status: 429, retryAfterMs: 31000 });
  });
});

describe('catalog-managed ElectronHub transcription', () => {
  function seed(model: string) {
    addKey('electronhub');
    applyCatalog(getDb(), { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', models: [], quirks: [],
      transcriptionModels: [{ platform: 'electronhub', modelId: model, displayName: model, priority: 1, enabled: true, quotaLabel: 'shared weekly allowance' }] });
  }
  const params = { file: Buffer.from('RIFF-audio-fixture'), filename: 'speech.wav', mimeType: 'audio/wav', language: 'en', prompt: 'Cafe', temperature: 0, responseFormat: 'json' };
  it.each(['voxtral-mini-2602', 'deepgram-nova-3'])('imports and routes %s through multipart speech, not chat', async model => {
    seed(model); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(response({ text: 'What time does the cafe close?', language: 'en', duration: 2.8 }));
    expect(TRANSCRIPTION_PLATFORMS.has('electronhub')).toBe(true);
    expect(await runTranscription(model, params)).toMatchObject({ platform: 'electronhub', modelId: model, text: 'What time does the cafe close?' });
    expect(fetch.mock.calls[0][0]).toBe('https://api.electronhub.ai/v1/audio/transcriptions');
    const init = fetch.mock.calls[0][1]!, form = init.body as FormData;
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer electronhub-test-key');
    expect(new Headers(init.headers).has('content-type')).toBe(false);
    expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== 'file'))).toEqual({ model, language: 'en', prompt: 'Cafe', temperature: '0', response_format: 'json' });
    expect((form.get('file') as File).name).toBe('speech.wav');
  });
  it.each([{ error: 'backend error' }, { text: 42 }, { text: 'hello', model: 'other' }])('rejects malformed or substituted transcription', async body => {
    seed('voxtral-mini-2602'); vi.spyOn(global, 'fetch').mockResolvedValue(response(body));
    await expect(runTranscription('voxtral-mini-2602', params)).rejects.toMatchObject({ status: 502 });
  });
});
