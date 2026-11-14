import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { parseKeysFromFile } from '../../lib/key-parser.js';
import { getProvider } from '../../providers/index.js';
import { runSpeech, runTranscription, MEDIA_PLATFORMS, TRANSCRIPTION_PLATFORMS } from '../../services/media.js';
import { cartesiaTranscription, voiceGatewaySpeech, CARTESIA_VERSION } from '../../services/media-voice-gateways.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { clearAllCooldowns, isOnCooldown } from '../../services/ratelimit.js';

function wav() {
  const out = Buffer.alloc(926);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(44100, 24); out.writeUInt32LE(88200, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(out.length - 44, 40);
  return out;
}
function seed(platform: string, model: string, modality = 'audio') {
  getDb().prepare('INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES (?,?,?,?,1,1)').run(platform, model, model, modality);
}
const params = { file: wav(), filename: 'speech.wav', mimeType: 'audio/wav', responseFormat: 'json', language: 'en' };
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  for (const platform of ['typecast', 'cartesia', 'silvr']) {
    const e = encrypt(`${platform}-synthetic-key`);
    getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES (?,'test',?,?,?,'unknown',1)").run(platform, e.encrypted, e.iv, e.authTag);
  }
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); getDb().close(); });

describe('catalog-only native voice gateways', () => {
  it.each(['typecast', 'cartesia'] as const)('%s never pretends to serve chat or spends credits validating a key', async platform => {
    const provider = getProvider(platform)!; const fetch = vi.spyOn(global, 'fetch');
    expect(provider.supportsChat).toBe(false); expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.validateKey('test')).rejects.toThrow('first speech request');
    await expect(provider.chatCompletion('test', [], 'any')).rejects.toMatchObject({ status: 400 });
    await expect(provider.streamChatCompletion('test', [], 'any').next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled(); expect(MEDIA_PLATFORMS.has(platform)).toBe(true);
    expect(isBuiltinDiscoveryEligible(getDb(), platform)).toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM media_models WHERE platform=?').get(platform)).toEqual({ n: 0 });
    expect(inferPoolForPlatform(platform, 'first')).toBe(inferPoolForPlatform(platform, 'second'));
    const parsed = parseKeysFromFile(`${platform.toUpperCase()}_API_KEY=synthetic`, 'keys.env');
    expect(parsed.keys[0]).toMatchObject({ platform, rawKey: `${platform.toUpperCase()}_API_KEY=synthetic` });
  });
  it.each(['ssfm-v31', 'ssfm-v30', 'ssfm-v21'])('routes Typecast %s through the app with native auth, voice and emotion payload', async model => {
    seed('typecast', model); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(wav()));
    expect(await runSpeech(model, { input: 'Hello', voice: 'alloy', format: 'wav' })).toMatchObject({ platform: 'typecast', modelId: model, contentType: 'audio/wav' });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.typecast.ai/v1/text-to-speech');
    expect(init?.redirect).toBe('error'); expect(new Headers(init?.headers).get('x-api-key')).toBe('typecast-synthetic-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model, text: 'Hello', voice_id: 'tc_672c5f5ce59fac2a48faeaee', prompt: { emotion_type: 'preset', emotion_preset: 'normal' }, output: { audio_format: 'wav' } });
  });
  it.each(['sonic-3.6', 'sonic-3.5', 'sonic-3'])('routes Cartesia %s with the current string voice schema', async model => {
    seed('cartesia', model); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(wav()));
    expect(await runSpeech(model, { input: 'Hello' })).toMatchObject({ platform: 'cartesia', contentType: 'audio/wav' });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cartesia-synthetic-key');
    expect(new Headers(init?.headers).get('cartesia-version')).toBe(CARTESIA_VERSION);
    expect(JSON.parse(String(init?.body))).toEqual({ model_id: model, transcript: 'Hello', voice: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', language: 'en', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 } });
  });
  it.each([
    ['typecast', 'ssfm-v31', { input: 'x'.repeat(2001) }], ['typecast', 'paid-model', { input: 'Hi' }],
    ['cartesia', 'sonic-preview', { input: 'Hi' }], ['cartesia', 'sonic-3.6', { input: ' ' }],
    ['typecast', 'ssfm-v31', { input: 'Hi', format: 'mp3' }], ['cartesia', 'sonic-3.6', { input: 'Hi', voice: 'https://attacker.invalid/voice' }],
  ] as const)('rejects unsupported native input before using quota: %s %s %j', async (platform, model, p) => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(voiceGatewaySpeech(platform, model, 'test', p)).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([Buffer.from('{}'), Buffer.from('RIFFfakeWAVE'), wav().subarray(0, 55)])('rejects malformed or truncated audio even with a WAV MIME type', async audio => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(audio, { headers: { 'Content-Type': 'audio/wav' } }));
    await expect(voiceGatewaySpeech('cartesia', 'sonic-3.6', 'test', { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
  });
  it.each([401, 402, 403, 429, 503])('preserves HTTP %s without exposing a provider error body', async status => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('echoed-secret', { status, headers: { 'Retry-After': '45' } }));
    const error = await voiceGatewaySpeech('typecast', 'ssfm-v31', 'test', { input: 'Hi' }).catch(e => e);
    expect(error).toMatchObject({ status, retryAfterMs: 45000 }); expect(error.message).not.toContain('echoed-secret');
  });
  it('bounds oversized downloads with and without Content-Length', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('tiny', { headers: { 'Content-Length': String(21 * 1024 * 1024) } })).mockResolvedValueOnce(new Response(new Uint8Array(20 * 1024 * 1024 + 1)));
    for (let i = 0; i < 2; i++) await expect(voiceGatewaySpeech('cartesia', 'sonic-3.6', 'test', { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uses a normal key/model cooldown after a rate-limited voice request', async () => {
    seed('typecast', 'ssfm-v31'); vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '45' } }));
    await expect(runSpeech('ssfm-v31', { input: 'Hi' })).rejects.toMatchObject({ status: 429, retryAfterMs: 45000 });
    const key = getDb().prepare("SELECT id FROM api_keys WHERE platform='typecast'").get() as { id: number };
    expect(isOnCooldown('typecast', 'ssfm-v31', key.id)).toBe(true);
  });
  it('routes Ink Whisper multipart transcription and logs recognized text', async () => {
    seed('cartesia', 'ink-whisper', 'transcription'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(Response.json({ type: 'transcript', text: 'Hello', duration: 1.25, language: 'en' }));
    expect(await runTranscription('ink-whisper', params)).toMatchObject({ platform: 'cartesia', text: 'Hello', duration: 1.25, language: 'en' });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://api.cartesia.ai/stt'); expect(init?.redirect).toBe('error');
    const form = init?.body as FormData; expect(form.get('model')).toBe('ink-whisper'); expect(form.get('language')).toBe('en');
    expect(await (form.get('file') as File).arrayBuffer()).toEqual(wav().buffer);
    expect(TRANSCRIPTION_PLATFORMS.has('cartesia')).toBe(true); expect(TRANSCRIPTION_PLATFORMS.has('typecast')).toBe(false);
    expect(inferPoolForPlatform('cartesia', 'ink-whisper')).toBe(inferPoolForPlatform('cartesia', 'sonic-3.6'));
  });
  it.each([{ prompt: 'hint' }, { temperature: 0.5 }, { responseFormat: 'vtt' }, { file: Buffer.alloc(0) }, { language: '../en' }])('rejects unsupported STT options before uploading %j', async extra => {
    const fetch = vi.spyOn(global, 'fetch'); await expect(cartesiaTranscription('ink-whisper', 'test', { ...params, ...extra })).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ error: 'down' }, { text: 42 }, { text: 'Hi', model: 'ink-2' }, { text: 'Hi', duration: -1 }, null])('rejects successful HTTP with invalid transcription metadata: %j', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(Response.json(body)); await expect(cartesiaTranscription('ink-whisper', 'test', params)).rejects.toMatchObject({ status: 502 });
  });
  it('accepts an empty final transcript for silence, not malformed JSON', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({ text: '' })).mockResolvedValueOnce(new Response('not json'));
    await expect(cartesiaTranscription('ink-whisper', 'test', params)).resolves.toMatchObject({ text: '' });
    await expect(cartesiaTranscription('ink-whisper', 'test', params)).rejects.toMatchObject({ status: 502 }); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('imports media through the catalog only, never into the chat pool', () => {
    applyCatalog(getDb(), { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
      models: ['typecast', 'cartesia'].map(platform => ({ platform, modelId: platform === 'typecast' ? 'ssfm-v31' : 'sonic-3.6', displayName: platform, modality: 'audio' as const, enabled: true, intelligenceRank: 200, speedRank: 10, sizeLabel: 'TTS', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Shared monthly credits; non-commercial', contextWindow: null, supportsTools: false, supportsVision: false })),
      transcriptionModels: [{ platform: 'cartesia', modelId: 'ink-whisper', displayName: 'Ink Whisper', enabled: true, priority: 10, quotaLabel: 'Shared monthly credits' }],
    });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform IN ('typecast','cartesia')").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform IN ('typecast','cartesia')").get()).toEqual({ n: 3 });
  });
});
