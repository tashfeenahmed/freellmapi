import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runSpeech, runTranscription, runVideoGeneration } from '../../services/media.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { NovaiProvider } from '../../providers/novai.js';
import * as guard from '../../lib/url-guard.js';

const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const wav = Buffer.alloc(64); wav.write('RIFF'); wav.write('WAVE', 8);
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const mp4 = Buffer.alloc(64); mp4.write('ftyp', 4);
const input = { file: wav, filename: 'speech.wav', mimeType: 'audio/wav', responseFormat: 'json' };
const outputUrl = 'https://maas-watermark-prod-new.cn-wlcb.ufileos.com/video.mp4?signature=test';
beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); getDb().close(); });
function seed(platform: string, model: string, modality: string, key = true) {
  if (key) {
    const enc = encrypt(platform === 'cloudflare' ? 'account:test-key' : 'unit-test-key');
    getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES (?,'test',?,?,?,'healthy',1)").run(platform, enc.encrypted, enc.iv, enc.authTag);
  }
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES (?,?,?,?,1,1,'shared allowance')").run(platform, model, model, modality);
}

describe('renewable audio routes', () => {
  it.each(['melotts', 'chatterbox', 'qwen3-tts', 'vibevoice'])('routes Free.ai %s and downloads without credentials', async model => {
    seed('freeai', model, 'audio');
    const url = 'https://api.free.ai/static/outputs/1bcc722e-4ddf-4e15-995a-b274000f99e5.wav';
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ audio_url: url })).mockResolvedValueOnce(new Response(wav));
    expect((await runSpeech(model, { input: 'hello' })).audio).toEqual(wav);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, text: 'hello', voice: 'default' });
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
    expect(fetch.mock.calls[1][1]?.redirect).toBe('error');
  });
  it.each(['en-us', 'de-de', 'es-es', 'it-it'])('routes keyless OVH %s to the fixed per-language endpoint', async lang => {
    const model = `nvr-tts-${lang}`; seed('ovh', model, 'audio', false);
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(wav));
    expect((await runSpeech(model, { input: 'hello', format: 'wav' })).audio).toEqual(wav);
    expect(fetch.mock.calls[0][0]).toBe(`https://${model}.endpoints.kepler.ai.cloud.ovh.net/api/v1/tts/text_to_audio`);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ encoding: 1, sample_rate_hz: 16000 });
  });
  it('uses Mistral voice_id and decodes audio_data', async () => {
    const model = 'voxtral-mini-tts-3-0'; seed('mistral', model, 'audio');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ audio_data: mp3.toString('base64') }));
    expect((await runSpeech(model, { input: 'hello', voice: 'alloy' })).audio).toEqual(mp3);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, input: 'hello', voice_id: 'gb_jane_neutral', response_format: 'mp3' });
  });
  it.each(['@cf/deepgram/aura-1', '@cf/deepgram/aura-2-en', '@cf/deepgram/aura-2-es'])('uses text and binary MP3 for %s', async model => {
    seed('cloudflare', model, 'audio');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(mp3));
    expect((await runSpeech(model, { input: 'hello' })).audio).toEqual(mp3);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ text: 'hello' });
  });
  it('uses the existing ElectronHub speech adapter for gpt-4o-mini-tts', async () => {
    seed('electronhub', 'gpt-4o-mini-tts', 'audio');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(mp3));
    expect((await runSpeech('gpt-4o-mini-tts', { input: 'hello' })).contentType).toBe('audio/mpeg');
  });
});

describe('transcription integration', () => {
  it.each([['freeai', 'whisper'], ['cohere', 'cohere-transcribe-03-2026'], ['cohere', 'cohere-transcribe-arabic-07-2026'], ['ovh', 'whisper-large-v3'], ['ovh', 'whisper-large-v3-turbo']])('supports %s %s uploads', async (platform, model) => {
    seed(platform, model, 'transcription', platform !== 'ovh');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ text: 'blue train', duration: 2 }));
    expect(await runTranscription(model, input)).toMatchObject({ text: 'blue train', duration: 2 });
    const form = fetch.mock.calls[0][1]?.body as FormData;
    expect([...form.keys()][0]).toBe('model');
    expect(Buffer.from(await (form.get('file') as File).arrayBuffer())).toEqual(wav);
    if (platform === 'cohere') expect([...form.keys()]).toEqual(['model', 'language', 'file']);
    if (platform === 'ovh') expect(new Headers(fetch.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
  });
  it('uses non-storing Google Interactions and parses model_output steps', async () => {
    const model = 'gemini-3.5-transcribe'; seed('google', model, 'transcription');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ status: 'completed', model, steps: [{ type: 'model_output', content: [{ type: 'text', text: 'blue train' }] }] }));
    expect((await runTranscription(model, input)).text).toBe('blue train');
    expect(fetch.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, store: false, input: [{ type: 'audio', data: wav.toString('base64'), mime_type: 'audio/wav' }] });
  });
  it('parses Cloudflare Nova 3 nested transcript', async () => {
    seed('cloudflare', '@cf/deepgram/nova-3', 'transcription');
    vi.spyOn(global, 'fetch').mockResolvedValue(json({ result: { results: { channels: [{ alternatives: [{ transcript: 'blue train' }] }] } } }));
    expect((await runTranscription('@cf/deepgram/nova-3', input)).text).toBe('blue train');
  });
  it.each([null, {}, { error: 'failed', text: 'bad' }, { text: 1 }])('rejects invalid transcription response %j', async body => {
    seed('freeai', 'whisper', 'transcription'); vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runTranscription('whisper', input)).rejects.toMatchObject({ status: 502 });
  });
});

describe('NovAI video', () => {
  it('does not spend quota or falsely validate a key using the public roster', async () => {
    const fetch = vi.spyOn(global, 'fetch'), provider = new NovaiProvider();
    expect(provider.supportsKeyValidation).toBe(false);
    await expect(provider.validateKey('test')).rejects.toThrow('unknown');
    await expect(provider.chatCompletion()).rejects.toMatchObject({ status: 400 });
    await expect(provider.streamChatCompletion().next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('polls without resubmission, then downloads MP4 without the API key', async () => {
    vi.useFakeTimers(); seed('novai', 'cogvideox-flash', 'video');
    vi.spyOn(guard, 'assessProviderUrl').mockResolvedValue({ allowed: true });
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ id: 'job-1', status: 'queued', model: 'cogvideox-flash' }))
      .mockResolvedValueOnce(json({ id: 'job-1', task_status: 'PROCESSING' }))
      .mockResolvedValueOnce(json({ id: 'job-1', task_status: 'SUCCESS', video_result: [{ url: outputUrl }] }))
      .mockResolvedValueOnce(new Response(mp4));
    const work = runVideoGeneration('cogvideox-flash', { prompt: 'a blue boat' });
    await vi.advanceTimersByTimeAsync(24_000);
    expect((await work).video).toEqual(mp4);
    expect(fetch.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls[1][0]).toBe('https://aiapi-pro.com/v1/video/generations/job-1?model=cogvideox-flash');
    expect(fetch.mock.calls[3][0]).toBe(outputUrl);
    expect(new Headers(fetch.mock.calls[3][1]?.headers).has('authorization')).toBe(false);
    expect(fetch.mock.calls.every(c => c[1]?.redirect === 'error')).toBe(true);
  });
  it.each(['http://127.0.0.1/a', 'https://evil.example/a.mp4', 'https://user@aiapi-pro.com/a', 'https://ufileos.com.evil.example/a'])('blocks unsafe output %s', async url => {
    seed('novai', 'cogvideox-flash', 'video');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ id: 'job', task_status: 'SUCCESS', video_result: [{ url }] }));
    await expect(runVideoGeneration('cogvideox-flash', { prompt: 'boat' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects paid aliases before sending credentials', async () => {
    seed('novai', 'paid-video', 'video'); const fetch = vi.spyOn(global, 'fetch');
    await expect(runVideoGeneration('paid-video', { prompt: 'boat' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains Retry-After on exhausted daily quota', async () => {
    seed('novai', 'cogvideox-flash', 'video'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({}, 429, { 'Retry-After': '60' }));
    await expect(runVideoGeneration('cogvideox-flash', { prompt: 'boat' })).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels polling and does not fail over after the client leaves', async () => {
    seed('novai', 'cogvideox-flash', 'video'); const abort = new AbortController();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ id: 'job', status: 'queued' }));
    const promise = runVideoGeneration('cogvideox-flash', { prompt: 'boat' }, abort.signal);
    const check = expect(promise).rejects.toMatchObject({ status: 499 });
    await new Promise(resolve => setTimeout(resolve, 10)); abort.abort(); await check;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it('keeps dedicated STT enabled when legacy audio duplicates are disabled; respects local disables', () => {
  seed('cohere', 'cohere-transcribe-arabic-07-2026', 'transcription');
  const modelId = 'cohere-transcribe-arabic-07-2026';
  const catalog = { version: '2099.01.01', generatedAt: '2099-01-01T00:00:00Z', tier: 'live' as const, quirks: [],
    models: [{ platform: 'cohere', modelId, displayName: 'legacy STT', modality: 'audio', enabled: false, intelligenceRank: 50, speedRank: 1, sizeLabel: '', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: '', contextWindow: null, supportsTools: false, supportsVision: false }],
    transcriptionModels: [{ platform: 'cohere', modelId, displayName: 'STT', priority: 1, enabled: true }],
    videoModels: [{ platform: 'novai', modelId: 'cogvideox-flash', displayName: 'CogVideoX', priority: 1, enabled: true }],
  };
  applyCatalog(getDb(), catalog); applyCatalog(getDb(), catalog);
  expect(getDb().prepare('SELECT enabled,modality FROM media_models WHERE platform=? AND model_id=?').get('cohere', modelId)).toEqual({ enabled: 1, modality: 'transcription' });
  expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='novai'").get()).toEqual({ n: 0 });
  getDb().prepare("UPDATE media_models SET enabled=0 WHERE platform='cohere'").run();
  applyCatalog(getDb(), catalog);
  expect(getDb().prepare('SELECT enabled FROM media_models WHERE platform=? AND model_id=?').get('cohere', modelId)).toEqual({ enabled: 0 });
});
