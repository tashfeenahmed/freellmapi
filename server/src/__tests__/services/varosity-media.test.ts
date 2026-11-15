import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runImageGeneration, runSpeech, runVideoGeneration, listMediaModels } from '../../services/media.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { VarosityProvider } from '../../providers/varosity.js';
import * as guard from '../../lib/url-guard.js';
import * as imageLibrary from '../../lib/image-normalize.js';

const base = 'https://varosity.ai/api';
const imageUrl = 'https://nkluppgbrrxbfkaktnks.supabase.co/storage/v1/object/public/varosity-assets/test/generated/image.png';
const audioUrl = 'https://nkluppgbrrxbfkaktnks.supabase.co/storage/v1/object/public/varosity-audio/test/audio.wav';
const videoUrl = 'https://v3b.fal.media/files/test/video.mp4';
const id = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const wav = Buffer.alloc(64); wav.write('RIFF'); wav.write('WAVE', 8);
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const mp4 = Buffer.alloc(64); mp4.write('ftyp', 4);
let jpeg: Buffer;
beforeAll(async () => { jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ff0000' } }).jpeg().toBuffer(); });
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  const enc = encrypt('test-varosity-key');
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('varosity','test',?,?,?,'healthy',1)").run(enc.encrypted, enc.iv, enc.authTag);
  vi.spyOn(guard, 'assessProviderUrl').mockResolvedValue({ allowed: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); getDb().close(); });
function seed(model: string, modality: string) {
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES ('varosity',?,?,?,1,1,'shared daily credits')").run(model, model, modality);
}

describe('Varosity credential management', () => {
  it('validates against an authenticated non-generating balance endpoint, including zero balance', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ ok: true, balance_cents: 0 }));
    expect(await new VarosityProvider().validateKey('test-key')).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(`${base}/v1/credits/balance`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-key');
  });
  it('rejects an invalid credential without treating scope/server errors as invalid keys', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({}, 403)).mockResolvedValueOnce(json({}, 429, { 'Retry-After': '60' }));
    const provider = new VarosityProvider();
    expect(await provider.validateKey('test')).toMatchObject({ valid: false });
    await expect(provider.validateKey('test')).rejects.toMatchObject({ status: 403 });
    await expect(provider.validateKey('test')).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([{}, null, { ok: false, balance_cents: 10 }, { ok: true, balance_cents: '10' }])('does not validate malformed balance %j', async body => {
    vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(new VarosityProvider().validateKey('test')).rejects.toThrow('unknown');
  });
  it('rejects chat and empty keys without network calls', async () => {
    const fetch = vi.spyOn(global, 'fetch'), provider = new VarosityProvider();
    expect(provider.supportsChat).toBe(false);
    expect(await provider.validateKey(' ')).toMatchObject({ valid: false });
    await expect(provider.chatCompletion()).rejects.toMatchObject({ status: 400 });
    await expect(provider.streamChatCompletion().next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Varosity images', () => {
  it.each(['flux-3-klein', 'flux-2-pro', 'qwen-image-3.0', 'gpt-image-2.5-flare'])('routes %s and normalizes JPEG to PNG', async model => {
    seed(model, 'image');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ ok: true, model, imageUrl, billing_mode: 'platform' })).mockResolvedValueOnce(new Response(jpeg));
    const result = await runImageGeneration(model, { prompt: 'red circle' });
    expect(await sharp(Buffer.from(result.images[0].b64_json!, 'base64')).metadata()).toMatchObject({ format: 'png', width: 16 });
    expect(fetch.mock.calls[0][0]).toBe(`${base}/v1/images`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model, prompt: 'red circle', aspect_ratio: '1:1', ...(model === 'gpt-image-2.5-flare' ? { providerOptions: { quality: 'low' } } : {}) });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('Idempotency-Key')).toMatch(/^[\w-]{36}$/);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
    expect(fetch.mock.calls.every(c => c[1]?.redirect === 'error')).toBe(true);
  });
  it.each([null, {}, { ok: false }, { ok: true, model: 'other', imageUrl }, { ok: true, model: 'flux-3-klein', imageUrl, billing_mode: 'byok' }])('rejects incorrect responses %j before downloading', async body => {
    seed('flux-3-klein', 'image'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json(body));
    await expect(runImageGeneration('flux-3-klein', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['http://127.0.0.1/file', 'https://169.254.169.254/a', 'https://evil.example/x', 'https://nkluppgbrrxbfkaktnks.supabase.co.evil.test/x', 'https://v3b.fal.media@evil.test/files/a', 'https://v3b.fal.media:444/files/a', 'https://v3b.fal.media/files/a#fragment', 'https://nkluppgbrrxbfkaktnks.supabase.co/storage/v1/object/private/a', 'https://other.supabase.co/storage/v1/object/public/varosity-assets/a'])('refuses unsafe output %s', async unsafe => {
    seed('flux-3-klein', 'image'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ ok: true, model: 'flux-3-klein', imageUrl: unsafe }));
    await expect(runImageGeneration('flux-3-klein', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('enforces the private-address guard on an allowlisted host', async () => {
    seed('flux-3-klein', 'image'); vi.mocked(guard.assessProviderUrl).mockResolvedValue({ allowed: false, reason: 'private' });
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ ok: true, model: 'flux-3-klein', imageUrl }));
    await expect(runImageGeneration('flux-3-klein', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([Buffer.from('<html>error</html>'), Buffer.from([255, 216, 255, 0])])('rejects non-image or corrupt bytes', async bytes => {
    seed('flux-3-klein', 'image'); vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ ok: true, model: 'flux-3-klein', imageUrl })).mockResolvedValueOnce(new Response(bytes));
    await expect(runImageGeneration('flux-3-klein', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
  });
  it.each([true, false])('bounds output downloads with content-length=%s', async withLength => {
    seed('flux-3-klein', 'image');
    let count = 0; const cancel = vi.fn();
    const stream = new ReadableStream({ pull(c) { if (count++ < 100) c.enqueue(new Uint8Array(1024 * 1024)); else c.close(); }, cancel });
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ ok: true, model: 'flux-3-klein', imageUrl })).mockResolvedValueOnce(new Response(stream, { headers: withLength ? { 'Content-Length': String(17 * 1024 * 1024) } : {} }));
    await expect(runImageGeneration('flux-3-klein', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 });
    expect(cancel).toHaveBeenCalled();
  });
  it.each([{ n: 2 }, { size: '512x512' }])('rejects unsupported parameters before spending quota %j', async options => {
    seed('flux-3-klein', 'image'); const fetch = vi.spyOn(global, 'fetch');
    await expect(runImageGeneration('flux-3-klein', { prompt: 'circle', ...options })).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it('fails before spending quota if the optional decoder cannot run', async () => {
    seed('flux-3-klein', 'image'); vi.spyOn(imageLibrary, 'cpuCanRunSharp').mockReturnValue(false); const fetch = vi.spyOn(global, 'fetch');
    await expect(runImageGeneration('flux-3-klein', { prompt: 'circle' })).rejects.toMatchObject({ status: 502 }); expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Varosity speech and music', () => {
  it.each([['openai-tts-1', 'openai-tts-1', mp3, 'audio/mpeg'], ['elevenlabs-tts-v3', 'eleven_v3', mp3, 'audio/mpeg'], ['fal-kokoro', 'fal-kokoro', wav, 'audio/wav'], ['heygen-voice-turbo', 'heygen-voice-turbo', wav, 'audio/wav']] as const)('routes %s and reports the actual encoding', async (model, modelId, bytes, contentType) => {
    seed(model, 'audio'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ ok: true, modelId, audioUrl })).mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'audio/mpeg' } }));
    expect(await runSpeech(model, { input: 'hello', voice: 'alloy', format: 'mp3' })).toMatchObject({ audio: bytes, contentType });
    expect(fetch.mock.calls[0][0]).toBe(`${base}/v1/tts`);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ voiceModel: model, text: 'hello', format: 'mp3', ...(model === 'openai-tts-1' ? { voiceId: 'alloy' } : {}) });
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has('authorization')).toBe(false);
  });
  it('rejects a substituted voice model', async () => {
    seed('openai-tts-1', 'audio'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ ok: true, modelId: 'wrong', audioUrl }));
    await expect(runSpeech('openai-tts-1', { input: 'hello' })).rejects.toMatchObject({ status: 502 }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('submits Lyria once and polls the native non-v1 music endpoint', async () => {
    vi.useFakeTimers(); seed('lyria-2', 'audio');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ ok: true, trackId: id, sync: false, providerJobId: 'fal-ai/lyria2#job' })).mockResolvedValueOnce(json({ ok: true, status: 'processing' })).mockResolvedValueOnce(json({ ok: true, status: 'succeeded', audioUrl })).mockResolvedValueOnce(new Response(wav));
    const work = runSpeech('lyria-2', { input: 'a calm piano piece' }); await vi.advanceTimersByTimeAsync(5000);
    expect((await work).contentType).toBe('audio/wav');
    expect(fetch.mock.calls.map(c => c[0])).toEqual([`${base}/v1/music`, `${base}/music/poll`, `${base}/music/poll`, audioUrl]);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ modelId: 'lyria-2', prompt: 'a calm piano piece', durationSec: 30, instrumental: true });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ trackId: id });
  });
  it.each(['failed', 'canceled', undefined, 'unknown'])('rejects music status %s without resubmitting', async status => {
    vi.useFakeTimers(); seed('lyria-2', 'audio');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ ok: true, trackId: id, sync: false, providerJobId: 'fal-ai/lyria2#job' })).mockResolvedValueOnce(json({ ok: true, status }));
    const work = expect(runSpeech('lyria-2', { input: 'piano' })).rejects.toMatchObject({ status: 502 }); await vi.advanceTimersByTimeAsync(3000); await work;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('fails closed on corrupt audio', async () => {
    seed('fal-kokoro', 'audio'); vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ ok: true, modelId: 'fal-kokoro', audioUrl })).mockResolvedValueOnce(new Response('not audio'));
    await expect(runSpeech('fal-kokoro', { input: 'hello' })).rejects.toMatchObject({ status: 502 });
  });
});

describe('Varosity video', () => {
  it('uses platform billing and polls the same job before credential-free MP4 download', async () => {
    vi.useFakeTimers(); seed('grok-imagine-video', 'video');
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json({ ok: true, jobId: id, status: 'rendering', billingMode: 'platform' })).mockResolvedValueOnce(json({ ok: true, jobId: id, status: 'queued' })).mockResolvedValueOnce(json({ ok: true, jobId: id, status: 'succeeded', outputUrl: videoUrl, error: null })).mockResolvedValueOnce(new Response(mp4));
    const work = runVideoGeneration('grok-imagine-video', { prompt: 'boat' }); await vi.advanceTimersByTimeAsync(5000);
    expect((await work).video).toEqual(mp4);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ modelId: 'grok-imagine-video', prompt: 'boat', durationSec: 1, aspectRatio: '16:9', authPreference: 'platform' });
    expect(fetch.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1);
    expect(fetch.mock.calls[1][0]).toBe(`${base}/v1/jobs/${id}`);
    expect(new Headers(fetch.mock.calls[3][1]?.headers).has('authorization')).toBe(false);
    expect(fetch.mock.calls.every(c => c[1]?.redirect === 'error')).toBe(true);
  });
  it.each([{ jobId: '../other', status: 'queued' }, { jobId: id, status: 'failed' }, { jobId: id, status: 'unknown' }, { jobId: id, status: 'queued', code: 'insufficient_credits' }, { jobId: id, status: 'queued', billingMode: 'byok' }])('rejects unsafe or held jobs %j', async job => {
    seed('grok-imagine-video', 'video'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ ok: true, ...job }));
    await expect(runVideoGeneration('grok-imagine-video', { prompt: 'boat' })).rejects.toMatchObject({ status: 502 }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels polling without another generation or failover', async () => {
    vi.useFakeTimers(); seed('grok-imagine-video', 'video'); const controller = new AbortController();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({ ok: true, jobId: id, status: 'queued' }));
    const work = expect(runVideoGeneration('grok-imagine-video', { prompt: 'boat' }, controller.signal)).rejects.toMatchObject({ status: 499 });
    await vi.advanceTimersByTimeAsync(100); controller.abort(); await work; expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('times out a stuck job under one overall deadline', async () => {
    vi.useFakeTimers(); seed('grok-imagine-video', 'video'); const fetch = vi.spyOn(global, 'fetch').mockImplementation(async () => json({ ok: true, jobId: id, status: 'queued' }));
    const work = expect(runVideoGeneration('grok-imagine-video', { prompt: 'boat' })).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(301000); await work; expect(fetch.mock.calls.filter(c => c[1]?.method === 'POST')).toHaveLength(1);
  });
  it.each([{ duration: 5 }, { aspectRatio: '9:16' as const }, { image: 'https://example.com/a.png' }, { seed: 1 }, { audio: false }])('rejects unsupported video options before spending quota %j', async options => {
    seed('grok-imagine-video', 'video'); const fetch = vi.spyOn(global, 'fetch');
    await expect(runVideoGeneration('grok-imagine-video', { prompt: 'boat', ...options })).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
});

it.each(['image', 'audio', 'video'])('excludes untested %s models before sending credentials', async modality => {
  seed('untested-paid-model', modality); const fetch = vi.spyOn(global, 'fetch');
  const work = modality === 'image' ? runImageGeneration('untested-paid-model', { prompt: 'test' }) : modality === 'audio' ? runSpeech('untested-paid-model', { input: 'test' }) : runVideoGeneration('untested-paid-model', { prompt: 'test' });
  await expect(work).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
});

it('keeps quota backoff in the media router', async () => {
  seed('openai-tts-1', 'audio'); const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(json({}, 429, { 'Retry-After': '60' }));
  await expect(runSpeech('openai-tts-1', { input: 'test' })).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 }); expect(fetch).toHaveBeenCalledTimes(1);
});

it('imports catalog media only and preserves local disables without seeding chat', () => {
  const model = (modelId: string, modality: string) => ({ platform: 'varosity', modelId, displayName: modelId, modality, enabled: true, intelligenceRank: 100, speedRank: 5, sizeLabel: '', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'shared daily credits', contextWindow: null, supportsTools: false, supportsVision: false });
  const catalog = { version: '2099.01.01', generatedAt: '2099-01-01T00:00:00Z', tier: 'live' as const, quirks: [], models: [model('flux-3-klein', 'image'), model('lyria-2', 'audio')], videoModels: [{ platform: 'varosity', modelId: 'grok-imagine-video', displayName: 'Grok', priority: 1, enabled: true }] };
  applyCatalog(getDb(), catalog); applyCatalog(getDb(), catalog);
  expect(listMediaModels('image')).toHaveLength(1); expect(listMediaModels('audio')).toHaveLength(1); expect(listMediaModels('video')).toHaveLength(1);
  expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='varosity'").get()).toEqual({ n: 0 });
  getDb().prepare("UPDATE media_models SET enabled=0 WHERE platform='varosity'").run(); applyCatalog(getDb(), catalog);
  expect(listMediaModels('image')).toHaveLength(0); expect(listMediaModels('audio')).toHaveLength(0); expect(listMediaModels('video')).toHaveLength(0);
});
