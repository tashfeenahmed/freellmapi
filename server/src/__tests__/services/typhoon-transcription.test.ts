import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runTranscription, TRANSCRIPTION_PLATFORMS } from '../../services/media.js';
import { clearCooldownsForKey, isOnCooldown } from '../../services/ratelimit.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { isBuiltinDiscoveryEligible } from '../../services/builtin-model-discovery.js';

const models = ['typhoon-asr-realtime', 'typhoon-isan-asr-realtime'];
const audio = Buffer.from('RIFFfakewavbytes');
const params = { file: audio, filename: 'sample.wav', mimeType: 'audio/wav', responseFormat: 'json' };

function seed() {
  const db = getDb();
  const encrypted = encrypt('typhoon-test-key');
  const key = db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('typhoon','test',?,?,?,'healthy',1)").run(encrypted.encrypted, encrypted.iv, encrypted.authTag);
  for (const [i, model] of models.entries()) {
    db.prepare("INSERT INTO media_models (platform,model_id,display_name,modality,priority,enabled,quota_label) VALUES ('typhoon',?,?,'transcription',?,1,'Free research API')").run(model, model, i);
  }
  return Number(key.lastInsertRowid);
}

describe('Typhoon transcription and catalog integration', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    for (let id = 1; id <= 10; id++) clearCooldownsForKey(id);
  });
  afterEach(() => vi.restoreAllMocks());

  it('has no bundled models or automatic discovery that could bypass catalog gating', () => {
    const db = getDb();
    expect(TRANSCRIPTION_PLATFORMS.has('typhoon')).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform='typhoon'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM media_models WHERE platform='typhoon'").get()).toEqual({ n: 0 });
    expect(isBuiltinDiscoveryEligible(db, 'typhoon')).toBe(false);
  });

  it.each(models)('posts multipart file/model and normalizes %s', async model => {
    seed();
    const fetch = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: 'สวัสดี', usage: { total_tokens: 10 } })));
    const result = await runTranscription(model, { ...params, language: 'th', prompt: 'hint', temperature: 0.2 });
    expect(result).toEqual({ platform: 'typhoon', modelId: model, text: 'สวัสดี' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.opentyphoon.ai/v1/audio/transcriptions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer typhoon-test-key');
    expect(new Headers(init?.headers).has('content-type')).toBe(false);
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(['file', 'model']);
    expect(form.get('model')).toBe(model);
    const file = form.get('file') as File;
    expect(file.name).toBe('sample.wav');
    expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
  });

  it.each(['text', 'verbose_json'])('normalizes output for the existing %s route formatter', async responseFormat => {
    seed();
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: 'สวัสดี' })));
    await expect(runTranscription(models[0], { ...params, responseFormat })).resolves.toMatchObject({ text: 'สวัสดี' });
  });

  it('does not advertise native VTT support', async () => {
    seed();
    const fetch = vi.spyOn(global, 'fetch');
    await expect(runTranscription(models[0], { ...params, responseFormat: 'vtt' })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{}, { text: 123 }, null])('rejects a successful response without transcription text (%j)', async body => {
    seed();
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(runTranscription(models[0], params)).rejects.toMatchObject({ status: 502 });
  });

  it('preserves a 429 retry delay and benches the affected key/model', async () => {
    const key = seed();
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Rate limited', { status: 429, headers: { 'Retry-After': '20' } }));
    await expect(runTranscription(models[0], params)).rejects.toMatchObject({ status: 429, retryAfterMs: 20_000 });
    expect(isOnCooldown('typhoon', models[0], key)).toBe(true);
  });

  it('ingests one chat and two transcription rows into separate registries, with no OCR', () => {
    const db = getDb();
    const counts = applyCatalog(db, {
      version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
      models: [{ platform: 'typhoon', modelId: 'typhoon-v2.5-30b-a3b-instruct', displayName: 'Typhoon 2.5', intelligenceRank: 50, speedRank: 20, sizeLabel: '30B A3B', limits: { rpm: null, rpd: null, tpm: null, tpd: null }, monthlyTokenBudget: 'Ongoing free research API', contextWindow: 131072, enabled: true, supportsVision: false, supportsTools: true }],
      transcriptionModels: models.map((modelId, priority) => ({ platform: 'typhoon', modelId, displayName: modelId, priority, enabled: true })),
    });
    expect(counts.skippedUnknownPlatform).toBe(0);
    expect(db.prepare("SELECT model_id FROM models WHERE platform='typhoon'").all()).toEqual([{ model_id: 'typhoon-v2.5-30b-a3b-instruct' }]);
    expect(db.prepare("SELECT model_id,modality FROM media_models WHERE platform='typhoon' ORDER BY priority").all()).toEqual(models.map(model_id => ({ model_id, modality: 'transcription' })));
  });
});
