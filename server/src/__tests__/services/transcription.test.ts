import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runTranscription, MediaError, listMediaModels, MAX_TRANSCRIPTION_BYTES } from '../../services/media.js';
import { isOnCooldown, clearCooldownsForKey } from '../../services/ratelimit.js';

const realFetch = globalThis.fetch;

function addKey(platform: string, raw = `${platform}-test-key`): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
  return Number(row.lastInsertRowid);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Seed the catalog-delivered STT registry (media_models, modality
 *  'transcription') exactly as the published `transcriptionModels` fragment
 *  would land it via catalog-sync. */
function seedTranscriptionModels(): void {
  const insert = getDb().prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, 'transcription', ?, 1, '', ?)
  `);
  insert.run('groq', 'whisper-large-v3-turbo', 'Whisper Large v3 Turbo (Groq)', 0,
    JSON.stringify({ maxBytes: 25 * 1024 * 1024 }));
  insert.run('groq', 'whisper-large-v3', 'Whisper Large v3 (Groq)', 1,
    JSON.stringify({ maxBytes: 25 * 1024 * 1024 }));
  insert.run('cloudflare', '@cf/openai/whisper-large-v3-turbo', 'Whisper Large v3 Turbo (Cloudflare Workers AI)', 2,
    JSON.stringify({ subtitleFormats: ['vtt'], requestStyle: 'json' }));
  insert.run('cloudflare', '@cf/openai/whisper', 'Whisper (Cloudflare Workers AI)', 3,
    JSON.stringify({ subtitleFormats: ['vtt'], requestStyle: 'binary' }));
}

const AUDIO = Buffer.from('RIFFfakewavbytes');

function params(overrides: Record<string, unknown> = {}) {
  return {
    file: AUDIO,
    filename: 'clip.wav',
    mimeType: 'audio/wav',
    responseFormat: 'json',
    ...overrides,
  } as any;
}

describe('transcription service', () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initDb(':memory:');
    getDb().prepare("DELETE FROM media_models").run();
    getDb().prepare("DELETE FROM api_keys").run();
    // Cooldowns live in a module-level map that outlives the per-test :memory:
    // DB; key ids restart at 1 in every test, so stale entries must be purged.
    for (let id = 1; id <= 10; id++) clearCooldownsForKey(id);
    seedTranscriptionModels();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('registry: enabled DB rows ordered by priority, groq ahead of cloudflare', () => {
    const rows = listMediaModels('transcription');
    expect(rows.map(m => m.platform)).toEqual(['groq', 'groq', 'cloudflare', 'cloudflare']);
    expect(rows.map(m => m.model_id)).toContain('whisper-large-v3-turbo');
    expect(rows.map(m => m.model_id)).toContain('@cf/openai/whisper');
  });

  it('empty registry (never-synced install) → 503 no_transcription_models, no fetch', async () => {
    getDb().prepare("DELETE FROM media_models WHERE modality = 'transcription'").run();
    addKey('groq');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    await expect(runTranscription('auto', params()))
      .rejects.toMatchObject({ status: 503, code: 'no_transcription_models' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a locally disabled row leaves the chain (pinning it → 400 unknown model)', async () => {
    getDb()
      .prepare("UPDATE media_models SET enabled = 0 WHERE model_id = 'whisper-large-v3'")
      .run();
    addKey('groq');
    globalThis.fetch = vi.fn(async () => jsonResponse({ text: 'ok' })) as any;
    await expect(runTranscription('whisper-large-v3', params()))
      .rejects.toMatchObject({ status: 400 });
    // auto still routes via the remaining rows.
    const r = await runTranscription('auto', params());
    expect(r.modelId).toBe('whisper-large-v3-turbo');
  });

  it('groq: sends multipart form to the OpenAI-compatible audio endpoint', async () => {
    addKey('groq');
    const fetchMock = vi.fn(async () => jsonResponse({ text: 'hello world' }));
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('whisper-large-v3-turbo', params({ language: 'en', prompt: 'ctx', temperature: 0.2 }));

    expect(r.platform).toBe('groq');
    expect(r.modelId).toBe('whisper-large-v3-turbo');
    expect(r.text).toBe('hello world');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer groq-test-key');
    // Content-Type must NOT be set by hand — FormData supplies the boundary.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('ctx');
    expect(form.get('temperature')).toBe('0.2');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('clip.wav');
    expect(Buffer.from(await file.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it('groq: requests verbose_json upstream and passes segments through', async () => {
    addKey('groq');
    const segments = [{ id: 0, start: 0, end: 1.5, text: 'hello' }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({ text: 'hello', language: 'en', duration: 1.5, segments }));
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('whisper-large-v3', params({ responseFormat: 'verbose_json' }));
    const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(r.segments).toEqual(segments);
    expect(r.language).toBe('en');
    expect(r.duration).toBe(1.5);
  });

  it('cloudflare @cf/openai/whisper: raw bytes body, account-scoped URL', async () => {
    addKey('cloudflare', 'acct123:token456');
    const fetchMock = vi.fn(async () =>
      jsonResponse({ result: { text: 'transcribed', word_count: 1, vtt: 'WEBVTT\n\n1' }, success: true }));
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('@cf/openai/whisper', params());
    expect(r.platform).toBe('cloudflare');
    expect(r.text).toBe('transcribed');
    expect(r.vtt).toContain('WEBVTT');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/openai/whisper');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token456');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(Buffer.from(init.body as Buffer).equals(AUDIO)).toBe(true);
  });

  it('cloudflare whisper-large-v3-turbo: JSON body with base64 audio', async () => {
    addKey('cloudflare', 'acct123:token456');
    const fetchMock = vi.fn(async () =>
      jsonResponse({ result: { text: 'turbo text', transcription_info: { language: 'en', duration: 2 } }, success: true }));
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('@cf/openai/whisper-large-v3-turbo', params({ language: 'en', prompt: 'hint' }));
    expect(r.text).toBe('turbo text');
    expect(r.language).toBe('en');
    expect(r.duration).toBe(2);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/openai/whisper-large-v3-turbo');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.audio).toBe(AUDIO.toString('base64'));
    expect(body.language).toBe('en');
    expect(body.initial_prompt).toBe('hint');
  });

  it('falls back to cloudflare when groq returns 429, and benches the groq key', async () => {
    const groqKeyId = addKey('groq');
    addKey('cloudflare', 'acct123:token456');
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('groq.com')) {
        return jsonResponse({ error: { message: 'rate limited' } }, 429);
      }
      return jsonResponse({ result: { text: 'cf fallback' }, success: true });
    });
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('auto', params());
    expect(r.platform).toBe('cloudflare');
    expect(r.text).toBe('cf fallback');
    // Both groq models were attempted and benched via the standard cooldown machinery.
    expect(isOnCooldown('groq', 'whisper-large-v3-turbo', groqKeyId)).toBe(true);
    expect(isOnCooldown('groq', 'whisper-large-v3', groqKeyId)).toBe(true);

    // A second request skips the benched groq key entirely.
    fetchMock.mockClear();
    await runTranscription('auto', params());
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('groq.com'))).toBe(false);
    expect(urls.some(u => u.includes('cloudflare.com'))).toBe(true);
  });

  it("'whisper-1' routes like auto (stock OpenAI clients send it by default)", async () => {
    addKey('groq');
    globalThis.fetch = vi.fn(async () => jsonResponse({ text: 'ok' })) as any;
    const r = await runTranscription('whisper-1', params());
    expect(r.platform).toBe('groq');
  });

  it('unknown model → 400 MediaError', async () => {
    addKey('groq');
    await expect(runTranscription('not-a-model', params()))
      .rejects.toMatchObject({ status: 400 });
  });

  it('vtt restricts the chain to natively capable providers (cloudflare)', async () => {
    addKey('groq');
    addKey('cloudflare', 'acct123:token456');
    const fetchMock = vi.fn(async () =>
      jsonResponse({ result: { text: 'x', vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nx' }, success: true }));
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('auto', params({ responseFormat: 'vtt' }));
    expect(r.platform).toBe('cloudflare');
    expect(r.vtt).toContain('WEBVTT');
    // groq must never have been attempted — it cannot produce vtt natively.
    expect(fetchMock.mock.calls.every(c => !String(c[0]).includes('groq.com'))).toBe(true);
  });

  it('vtt pinned to a groq model → 400 (not produced natively)', async () => {
    addKey('groq');
    await expect(runTranscription('whisper-large-v3', params({ responseFormat: 'vtt' })))
      .rejects.toMatchObject({ status: 400 });
  });

  it('oversized file → 413 before any provider is called', async () => {
    addKey('groq');
    addKey('cloudflare', 'acct123:token456');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    const big = Buffer.alloc(MAX_TRANSCRIPTION_BYTES + 1);
    await expect(runTranscription('auto', params({ file: big })))
      .rejects.toMatchObject({ status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no usable keys → 503-family MediaError, no fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    await expect(runTranscription('auto', params())).rejects.toBeInstanceOf(MediaError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A user-registered OpenAI-compatible STT box (platform 'custom'). Its row
  // is bound to one api_keys row that carries the base_url —
  // getProviderCredential refuses to guess a key for 'custom', so the
  // candidate MUST carry key_id or the row is silently skipped.
  function addCustomStt(model = 'local-whisper', secret = 'stt-secret', baseUrl = 'http://127.0.0.1:9911/v1'): number {
    const { encrypted, iv, authTag } = encrypt(secret);
    const key = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES ('custom', 'Local STT', ?, ?, ?, 'unknown', 1, ?)
    `).run(encrypted, iv, authTag, baseUrl);
    const keyId = Number(key.lastInsertRowid);
    getDb().prepare(`
      INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
      VALUES ('custom', ?, 'Local Whisper', 'transcription', 99, 1, 'custom endpoint', ?)
    `).run(model, keyId);
    return keyId;
  }

  it('custom: multipart POST to the endpoint\'s own /audio/transcriptions with its key', async () => {
    addCustomStt();
    const fetchMock = vi.fn(async () => jsonResponse({ text: 'local text', language: 'en', duration: 3 }));
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('local-whisper', params({ language: 'en', prompt: 'ctx', temperature: 0.3 }));
    expect(r.platform).toBe('custom');
    expect(r.text).toBe('local text');
    expect(r.language).toBe('en');
    expect(r.duration).toBe(3);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9911/v1/audio/transcriptions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer stt-secret');
    // Content-Type must NOT be set by hand — FormData supplies the boundary.
    expect(headers['Content-Type']).toBeUndefined();
    const form = init.body as FormData;
    expect(form.get('model')).toBe('local-whisper');
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('ctx');
    expect(form.get('temperature')).toBe('0.3');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('clip.wav');
    expect(Buffer.from(await file.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it('custom: the row is NOT skipped for want of a key (key_id must reach getProviderCredential)', async () => {
    // No catalog rows at all: if the custom candidate dropped its key_id the
    // chain would come up empty and this would throw instead of transcribing.
    getDb().prepare("DELETE FROM media_models WHERE platform IN ('groq', 'cloudflare')").run();
    addCustomStt();
    const fetchMock = vi.fn(async () => jsonResponse({ text: 'reached' }));
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('auto', params());
    expect(r.platform).toBe('custom');
    expect(r.text).toBe('reached');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('custom: verbose_json is asked for upstream and segments pass through', async () => {
    addCustomStt();
    const segments = [{ id: 0, start: 0, end: 1, text: 'local text' }];
    const fetchMock = vi.fn(async () => jsonResponse({ text: 'local text', segments }));
    globalThis.fetch = fetchMock as any;

    const r = await runTranscription('local-whisper', params({ responseFormat: 'verbose_json' }));
    const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(r.segments).toEqual(segments);
  });

  it('custom: an endpoint whose key row lost its base_url fails loudly, not silently', async () => {
    const keyId = addCustomStt();
    getDb().prepare('UPDATE api_keys SET base_url = NULL WHERE id = ?').run(keyId);
    globalThis.fetch = vi.fn() as any;
    await expect(runTranscription('local-whisper', params()))
      .rejects.toMatchObject({ status: 502 }); // chainError wraps the 500 adapter error
  });

  it("custom: vtt is refused — no custom row declares native subtitles", async () => {
    addCustomStt();
    await expect(runTranscription('local-whisper', params({ responseFormat: 'vtt' })))
      .rejects.toMatchObject({ status: 400 });
  });

  it('logs transcription requests with request_type=transcription', async () => {
    addKey('groq');
    globalThis.fetch = vi.fn(async () => jsonResponse({ text: 'logged' })) as any;
    await runTranscription('auto', params());
    const row = getDb()
      .prepare("SELECT platform, model_id, status, request_type FROM requests ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(row.platform).toBe('groq');
    expect(row.request_type).toBe('transcription');
    expect(row.status).toBe('success');
  });
});
