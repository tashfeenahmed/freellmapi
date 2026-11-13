import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runImageGeneration, runTranscription, MEDIA_PLATFORMS, TRANSCRIPTION_PLATFORMS } from '../../services/media.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';

const imageModel = 'agnes-image-2-5-flash:free';
const sttModels = ['voxtral-mini-transcribe-3', 'voxtral-small-transcribe-3'];
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const audio = Buffer.from('RIFFfakewavbytes');
const params = { file: audio, filename: 'speech.wav', mimeType: 'audio/wav', responseFormat: 'json' };
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

function seed(platform: string, model: string, modality: string) {
  const key = encrypt('unit-test-key');
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES (?,'test',?,?,?,'healthy',1)").run(platform, key.encrypted, key.iv, key.authTag);
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES (?,?,?,?,1,1,'shared free allowance')").run(platform, model, model, modality);
}

describe('Kenari images', () => {
  it('uses exact :free ID and tested OpenAI image payload', async () => {
    seed('kenari', imageModel, 'image');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    expect(await runImageGeneration(imageModel, { prompt: 'blue circle' })).toEqual({ platform: 'kenari', modelId: imageModel, images: [{ b64_json: 'aW1hZ2U=' }] });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://kenari.id/v1/images/generations');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer unit-test-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model: imageModel, prompt: 'blue circle', n: 1, size: '1024x1024', response_format: 'b64_json' });
  });
  it.each([null, {}, { data: [] }, { data: [null] }, { data: [{ b64_json: '' }] }, { data: [{ url: 'https://example.com/image' }] }])('rejects malformed/empty images %j', async body => {
    seed('kenari', imageModel, 'image');
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runImageGeneration(imageModel, { prompt: 'blue circle' })).rejects.toMatchObject({ status: 502 });
  });
  it('does not retry a paid alias on quota exhaustion', async () => {
    seed('kenari', imageModel, 'image');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ error: 'quota' }, 429, { 'Retry-After': '30' }));
    await expect(runImageGeneration(imageModel, { prompt: 'blue circle' })).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Mistral transcription', () => {
  it.each(sttModels)('dispatches %s using documented multipart fields', async model => {
    seed('mistral', model, 'transcription');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ model, text: 'สวัสดี', language: 'th', segments: [] }));
    expect(await runTranscription(model, { ...params, language: 'th', temperature: 0.2, prompt: 'Do not send this Whisper field' })).toEqual({ platform: 'mistral', modelId: model, text: 'สวัสดี', language: 'th', segments: [] });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.mistral.ai/v1/audio/transcriptions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer unit-test-key');
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(['file', 'model', 'language', 'temperature']);
    expect(form.get('model')).toBe(model);
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(audio);
  });
  it.each([null, {}, { text: 1 }, { text: 'bad', error: 'failed' }])('rejects malformed transcription %j', async body => {
    seed('mistral', sttModels[0], 'transcription');
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runTranscription(sttModels[0], params)).rejects.toMatchObject({ status: 502 });
  });
  it('preserves retry-after and does not claim native VTT', async () => {
    seed('mistral', sttModels[0], 'transcription');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({}, 429, { 'Retry-After': '20' }));
    await expect(runTranscription(sttModels[0], { ...params, responseFormat: 'vtt' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    await expect(runTranscription(sttModels[0], params)).rejects.toMatchObject({ status: 429, retryAfterMs: 20_000 });
  });
});

it('ingests catalog-only chat, image and transcription rows idempotently into separate registries', () => {
  expect(MEDIA_PLATFORMS.has('kenari')).toBe(true);
  expect(TRANSCRIPTION_PLATFORMS.has('mistral')).toBe(true);
  const catalog = { version: '2099.01.01', generatedAt: '2099-01-01T00:00:00Z', tier: 'live' as const, quirks: [],
    models: ['chat', 'image'].map(modality => ({ platform: 'kenari', modelId: modality === 'image' ? imageModel : 'qwen3-8-omni-flash:free', displayName: modality,
      ...(modality === 'image' ? { modality: 'image' as const } : {}), intelligenceRank: 50, speedRank: 10, sizeLabel: '', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Shared daily allowance', contextWindow: null, enabled: true, supportsVision: false, supportsTools: false })),
    transcriptionModels: sttModels.map(modelId => ({ platform: 'mistral', modelId, displayName: modelId, priority: 1, enabled: true, premiumSince: '2099-01-01T00:00:00Z' })),
  };
  expect(applyCatalog(getDb(), catalog).skippedUnknownPlatform).toBe(0);
  expect(applyCatalog(getDb(), catalog).inserted).toBe(0);
  expect(getDb().prepare("SELECT model_id FROM models WHERE platform='kenari'").all()).toEqual([{ model_id: 'qwen3-8-omni-flash:free' }]);
  expect(getDb().prepare("SELECT model_id,modality FROM media_models WHERE platform IN ('kenari','mistral') ORDER BY platform,model_id").all()).toEqual([
    { model_id: imageModel, modality: 'image' }, ...sttModels.map(model_id => ({ model_id, modality: 'transcription' })),
  ]);
});
