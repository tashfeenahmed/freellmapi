import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { MEDIA_PLATFORMS, runSpeech } from '../../services/media.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const models = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'humain-tts'];
const wav = Buffer.alloc(48);
wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(24)]);

function seed() {
  const db = getDb(), secret = encrypt('electronhub-test-key');
  db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('electronhub','test',?,?,?,'healthy',1)")
    .run(secret.encrypted, secret.iv, secret.authTag);
  models.forEach((model, i) => db.prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled) VALUES ('electronhub',?,?,'audio',?,1)").run(model, model, i));
}

describe('ElectronHub speech and Plugsky catalog integration', () => {
  beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });
  afterEach(() => vi.restoreAllMocks());

  it.each(models)('routes %s to speech with a compatible default voice', async model => {
    seed();
    const audio = model === 'humain-tts' ? mp3 : wav;
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(audio, { headers: { 'content-type': 'application/octet-stream' } }));
    const result = await runSpeech(model, { input: 'Hello', voice: 'alloy' });
    expect(result).toMatchObject({ platform: 'electronhub', modelId: model, audio, contentType: model === 'humain-tts' ? 'audio/mpeg' : 'audio/wav' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.electronhub.ai/v1/audio/speech');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer electronhub-test-key');
    expect(JSON.parse(String(init?.body))).toEqual({ model, input: 'Hello', voice: model === 'humain-tts' ? 'sara' : 'Kore', response_format: 'mp3' });
  });

  it('forwards an explicit voice and format, and detects actual audio instead of trusting MIME', async () => {
    seed();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(wav, { headers: { 'content-type': 'audio/mpeg' } }));
    expect((await runSpeech(models[0], { input: 'Hi', voice: 'Puck', format: 'wav' })).contentType).toBe('audio/wav');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ voice: 'Puck', response_format: 'wav' });
  });

  it.each(['', '{"error":"private upstream details"}', '<html>Error</html>', 'RIFFnot audio'])('rejects empty or non-audio HTTP 200 bodies without echoing them', async body => {
    seed();
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'audio/mpeg' } }));
    await expect(runSpeech(models[0], { input: 'Hi' })).rejects.toMatchObject({ status: 502 });
    expect((getDb().prepare("SELECT error FROM requests WHERE request_type='audio'").get() as { error: string }).error).not.toContain('private upstream details');
  });

  it('rejects unimplemented raw PCM before calling upstream', async () => {
    seed();
    const fetch = vi.spyOn(global, 'fetch');
    await expect(runSpeech(models[0], { input: 'Hi', format: 'pcm' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves rate-limit retry hints', async () => {
    seed();
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Rate limited', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(runSpeech(models[0], { input: 'Hi' })).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
  });

  it('has no Plugsky seeds or automatic discovery; ingests chat and speech separately', () => {
    const db = getDb();
    expect(MEDIA_PLATFORMS.has('electronhub')).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform='plugsky'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(db, 'plugsky')).toBe(false);
    const row = (platform: string, modelId: string) => ({ platform, modelId, displayName: modelId, intelligenceRank: 50, speedRank: 50, sizeLabel: '', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Shared free quota', contextWindow: 131072, enabled: true, supportsVision: false, supportsTools: false });
    const counts = applyCatalog(db, {
      version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
      models: [
        ...['plugsky-micro', 'plugsky-lite'].map(id => row('plugsky', id)),
        ...models.map(id => ({ ...row('electronhub', id), modality: 'audio' as const })),
      ],
    });
    expect(counts.skippedUnknownPlatform).toBe(0);
    expect(db.prepare("SELECT model_id FROM models WHERE platform='plugsky' ORDER BY model_id").all()).toEqual([{ model_id: 'plugsky-lite' }, { model_id: 'plugsky-micro' }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform='electronhub' AND model_id LIKE '%tts'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT model_id,modality FROM media_models WHERE platform='electronhub' ORDER BY model_id").all()).toEqual(models.map(model_id => ({ model_id, modality: 'audio' })).sort((a, b) => a.model_id.localeCompare(b.model_id)));
  });
});
