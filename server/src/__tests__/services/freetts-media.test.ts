import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { FreeTtsProvider } from '../../providers/freetts.js';
import { getProvider } from '../../providers/index.js';
import { freeTtsSpeech } from '../../services/media-freetts.js';
import { runSpeech } from '../../services/media.js';
import { inferPoolForPlatform } from '../../services/provider-quota.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';
import { clearAllCooldowns, isOnCooldown } from '../../services/ratelimit.js';

const fileId = '009e7e47-4b99-418a-b726-6da76acd7af9';
const metadata = (extra = {}) => Response.json({ file_id: fileId, voice: 'en-US-JennyNeural', format: 'mp3', downgraded: false, watermark: 'end', ...extra });
function mp3() {
  // Two complete MPEG-2 Layer III frames, 64 kb/s at 24 kHz, mono.
  const audio = Buffer.alloc(384);
  for (const offset of [0, 192]) audio.set([0xff, 0xf3, 0x84, 0xc0], offset);
  return audio;
}
beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:');
  clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  const key = encrypt('freetts-synthetic-key');
  getDb().prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('freetts','test',?,?,?,'unknown',1)").run(key.encrypted, key.iv, key.authTag);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); getDb().close(); });
function seed() {
  getDb().prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES ('freetts','neural-tts','FreeTTS Neural TTS','audio',1,1)").run();
}

describe('FreeTTS personal BYOK speech', () => {
  it('registers speech only without pretending the public roster validates credentials or seeding models', async () => {
    const provider = getProvider('freetts')!;
    expect(provider).toBeInstanceOf(FreeTtsProvider);
    expect(provider.supportsChat).toBe(false); expect(provider.supportsKeyValidation).toBe(false);
    expect(isBuiltinDiscoveryEligible(getDb(), 'freetts')).toBe(false);
    const fetch = vi.spyOn(global, 'fetch');
    await expect(provider.validateKey('not-a-real-key')).rejects.toThrow('first speech request');
    await expect(provider.chatCompletion('not-a-real-key', [], 'neural-tts')).rejects.toMatchObject({ status: 400 });
    await expect(provider.streamChatCompletion('not-a-real-key', [], 'neural-tts').next()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform='freetts'").get()).toEqual({ n: 0 });
    expect(inferPoolForPlatform('freetts', 'neural-tts')).toBe('freetts::monthly-characters');
    expect(inferPoolForPlatform('freetts', 'another-voice')).toBe('freetts::monthly-characters');
  });
  it('routes through the app media chain, downloads from a fixed host and preserves all MP3/watermark bytes', async () => {
    seed(); const audio = mp3();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(metadata({ audio_url: 'https://attacker.invalid/steal' })).mockResolvedValueOnce(new Response(audio, { headers: { 'Content-Type': 'application/octet-stream' } }));
    const result = await runSpeech('neural-tts', { input: 'Hello', voice: 'alloy' });
    expect(result).toMatchObject({ platform: 'freetts', modelId: 'neural-tts', contentType: 'audio/mpeg' }); expect(result.audio).toEqual(audio);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe('https://freetts.org/api/v1/tts');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ text: 'Hello', voice: 'en-US-JennyNeural', rate: '+0%', pitch: '+0Hz', output_format: 'mp3' });
    expect(fetch.mock.calls[1][0]).toBe('https://freetts.org/api/audio/' + fileId);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get('x-api-key')).toBe('freetts-synthetic-key');
      expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetch.mock.calls[0][1]?.signal).toBe(fetch.mock.calls[1][1]?.signal);
    expect(getDb().prepare("SELECT status FROM api_keys WHERE platform='freetts'").get()).toEqual({ status: 'healthy' });
  });
  it('passes a requested native voice instead of treating it as a separate model', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(metadata({ voice: 'en-GB-SoniaNeural' })).mockResolvedValueOnce(new Response(mp3()));
    await freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hello', voice: 'en-GB-SoniaNeural', format: 'mp3' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).voice).toBe('en-GB-SoniaNeural');
  });
  it.each([{ input: '' }, { input: ' ' }, { input: 'x'.repeat(1001) }, { input: '<speak>Hi</speak>' }, { input: 'Hi', format: 'wav' }, { input: 'Hi', format: 'mp3-hd' }, { input: 'Hi', voice: 'https://attacker.invalid' }])('rejects unsupported requests before using quota %j', async p => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(freeTtsSpeech('neural-tts', 'synthetic-key', p)).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it('requires the local key and known catalog engine', async () => {
    const fetch = vi.spyOn(global, 'fetch');
    await expect(freeTtsSpeech('neural-tts', null, { input: 'Hi' })).rejects.toMatchObject({ status: 401 });
    await expect(freeTtsSpeech('paid-engine', 'synthetic-key', { input: 'Hi' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ file_id: '../../admin' }, { file_id: 'https://attacker.invalid/audio' }, { voice: 'en-US-GuyNeural' }, { downgraded: true }, { format: 'wav' }, { error: 'failed' }])('rejects malformed or substituted generation metadata without downloading %j', async extra => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(metadata(extra));
    await expect(freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hi' })).rejects.toMatchObject({ status: 502 }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([Buffer.from('{"error":"not audio"}'), Buffer.from('ID3fake'), mp3().subarray(0, 200)])('rejects JSON errors, fake ID3 headers and truncated MP3 frames', async audio => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } }));
    await expect(freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
  });
  it('accepts ID3 metadata only when complete MP3 frames follow it', async () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
    const audio = Buffer.concat([id3, mp3()]);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response(audio));
    expect((await freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hi' })).audio).toEqual(audio);
  });
  it('bounds JSON bodies even without Content-Length and bounds downloads before reading them', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('x'.repeat(65537)));
    await expect(freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
    fetch.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response('small body', { headers: { 'Content-Length': String(21 * 1024 * 1024) } }));
    await expect(freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
  });
  it('preserves authentication/quota status and Retry-After for normal router failover', async () => {
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '45' } }));
    await expect(freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hi' })).rejects.toMatchObject({ status: 401 });
    await expect(freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hi' })).rejects.toMatchObject({ status: 429, retryAfterMs: 45000 });
    fetch.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    await expect(freeTtsSpeech('neural-tts', 'synthetic-key', { input: 'Hi' })).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
  });
  it('keeps catalog speech out of chat and does not bypass signed catalog delivery', () => {
    applyCatalog(getDb(), { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
      models: [{ platform: 'freetts', modelId: 'neural-tts', displayName: 'FreeTTS Neural TTS', modality: 'audio', enabled: true, intelligenceRank: 100, speedRank: 10, sizeLabel: 'TTS', limits: { rpm: 10, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Shared monthly characters; personal use only', contextWindow: null, supportsTools: false, supportsVision: false }],
    });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM models WHERE platform='freetts'").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform='freetts'").get()).toEqual({ n: 1 });
  });
  it('benches a rate-limited FreeTTS credential through the normal media router', async () => {
    seed(); vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '45' } }));
    await expect(runSpeech('neural-tts', { input: 'Hello' })).rejects.toMatchObject({ status: 429, retryAfterMs: 45000 });
    const key = getDb().prepare("SELECT id FROM api_keys WHERE platform='freetts'").get() as { id: number };
    expect(isOnCooldown('freetts', 'neural-tts', key.id)).toBe(true);
  });
});
