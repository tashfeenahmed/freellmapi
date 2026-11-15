import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { MEDIA_PLATFORMS, runSpeech } from '../../services/media.js';
import { applyCatalog } from '../../services/catalog-sync.js';

const models = ['canopylabs/orpheus-v1-english', 'canopylabs/orpheus-arabic-saudi'];
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
function seed(model = models[0]) {
  const db = getDb(), key = encrypt('groq-speech-test-key');
  db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('groq','speech',?,?,?,'healthy',1)").run(key.encrypted, key.iv, key.authTag);
  db.prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES ('groq',?,?,'audio',1,1)").run(model, model);
}
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
afterEach(() => { vi.restoreAllMocks(); getDb().close(); });

describe('Groq Orpheus speech', () => {
  it.each([[models[0], 'troy'], [models[1], 'fahad']])('routes %s with the correct default voice and original WAV', async (model, voice) => {
    seed(model); const audio = wav(), fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(audio));
    const result = await runSpeech(model, { input: 'Hello', voice: 'alloy' });
    expect(result).toMatchObject({ platform: 'groq', modelId: model, contentType: 'audio/wav', audio });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/speech'); expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer groq-speech-test-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model, input: 'Hello', voice, response_format: 'wav' });
  });
  it('normalizes an explicit native voice without replacing it', async () => {
    seed(); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(wav()));
    await runSpeech(models[0], { input: 'Hi', voice: ' Hannah ', format: 'wav' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).voice).toBe('hannah');
  });
  it('normalizes Groq streamed WAV length sentinels and preserves samples and metadata', async () => {
    seed(); const header = wav().subarray(0, 36), metadata = Buffer.alloc(12), data = Buffer.alloc(12);
    metadata.write('LIST'); metadata.writeUInt32LE(4, 4); metadata.write('INFO', 8);
    data.write('data'); data.writeUInt32LE(0xffffffff, 4); data.writeInt16LE(1234, 8); data.writeInt16LE(-1234, 10);
    const streamed = Buffer.concat([header, metadata, data]); streamed.writeUInt32LE(0xffffffff, 4);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(streamed));
    const result = await runSpeech(models[0], { input: 'Hi' });
    expect(result.audio.readUInt32LE(4)).toBe(streamed.length - 8);
    expect(result.audio.readUInt32LE(52)).toBe(4);
    expect(result.audio.subarray(56)).toEqual(data.subarray(8));
    expect(result.audio.subarray(36, 48)).toEqual(metadata);
  });
  it.each([{ input: ' ' }, { input: 'x'.repeat(201) }, { input: 'Hi', voice: 'fahad' }, { input: 'Hi', format: 'mp3' }])('rejects unsupported input before spending quota %j', async input => {
    seed(); const fetch = vi.spyOn(global, 'fetch'); await expect(runSpeech(models[0], input)).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not accept a chat model as a speech selector', async () => {
    seed('openai/gpt-oss-20b'); const fetch = vi.spyOn(global, 'fetch');
    await expect(runSpeech('openai/gpt-oss-20b', { input: 'Hi' })).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([Buffer.from('{}'), Buffer.from('RIFFinvalid'), wav().subarray(0, 47)])('rejects malformed HTTP 200 bodies', async audio => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(new Response(audio, { headers: { 'Content-Type': 'audio/wav' } }));
    await expect(runSpeech(models[0], { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
  });
  it('rejects a RIFF header with invalid format or no samples', async () => {
    seed(); const float = wav(); float.writeUInt16LE(3, 20); const empty = wav(); empty.writeUInt32LE(0, 40);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(float)).mockResolvedValueOnce(new Response(empty));
    await expect(runSpeech(models[0], { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
    await expect(runSpeech(models[0], { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
  });
  it('preserves provider rate-limit backoff', async () => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(runSpeech(models[0], { input: 'Hi' })).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
  });
  it('fails over after malformed successful audio instead of serving the error body', async () => {
    seed();
    getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES ('groq',?,?,'audio',2,1)").run(models[1], models[1]);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{"private":"upstream error"}')).mockResolvedValueOnce(new Response(wav()));
    const result = await runSpeech('auto', { input: 'Hello' });
    expect(result.modelId).toBe(models[1]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getDb().prepare("SELECT error FROM requests WHERE error IS NOT NULL").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ error: expect.stringContaining('private') })]));
  });
  it('surfaces model-terms acceptance errors without accepting terms', async () => {
    seed(); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"error":{"code":"model_terms_required"}}', { status: 400 }));
    await expect(runSpeech(models[0], { input: 'Hi' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('imports speech rows into media only, with no bundled model seeds', () => {
    expect(MEDIA_PLATFORMS.has('groq')).toBe(true);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform='groq' AND modality='audio'").get()).toEqual({ n: 0 });
    applyCatalog(getDb(), { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
      models: models.map(modelId => ({ platform: 'groq', modelId, displayName: modelId, modality: 'audio', enabled: true, intelligenceRank: 220, speedRank: 2, sizeLabel: 'TTS', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Shared recurring daily Groq free quota', contextWindow: null, supportsTools: false, supportsVision: false })),
    });
    expect(getDb().prepare("SELECT model_id FROM media_models WHERE platform='groq' AND modality='audio' ORDER BY model_id").all()).toEqual([...models].sort().map(model_id => ({ model_id })));
    expect(getDb().prepare("SELECT model_id FROM models WHERE platform='groq' AND model_id LIKE 'canopylabs/%'").all()).toEqual([]);
  });
});
