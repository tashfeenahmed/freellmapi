import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runImageGeneration, runSpeech, MediaError } from '../../services/media.js';

const realFetch = globalThis.fetch;

function addKey(platform: string, raw = `${platform}-test-key`) {
  const { encrypted, iv, authTag } = encrypt(raw);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag);
}

function addCustomKey(baseUrl: string, raw = 'custom-media-key'): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'test', ?, ?, ?, 'healthy', 1, ?)
  `).run(encrypted, iv, authTag, baseUrl);
  return Number(row.lastInsertRowid);
}

function addMedia(platform: string, modelId: string, modality: 'image' | 'audio', priority = 1, keyId: number | null = null) {
  getDb().prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id)
    VALUES (?, ?, ?, ?, ?, 1, '', ?)
  `).run(platform, modelId, modelId, modality, priority, keyId);
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('media service', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('migration creates the media_models table', () => {
    const cols = (getDb().prepare('PRAGMA table_info(media_models)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('modality');
    expect(cols).toContain('quota_label');
    expect(cols).toContain('key_id');
  });

  describe('image generation', () => {
    it('NVIDIA: maps artifacts[].base64 → b64_json', async () => {
      addMedia('nvidia', 'black-forest-labs/flux.1-schnell', 'image');
      addKey('nvidia');
      globalThis.fetch = vi.fn(async () => jsonResponse({ artifacts: [{ base64: 'AAAA' }] })) as any;
      const r = await runImageGeneration('black-forest-labs/flux.1-schnell', { prompt: 'a cat' });
      expect(r.platform).toBe('nvidia');
      expect(r.images[0].b64_json).toBe('AAAA');
    });

    it('Pollinations: keyless GET, raw bytes → b64_json (no api key needed)', async () => {
      addMedia('pollinations', 'flux', 'image');
      globalThis.fetch = vi.fn(async () =>
        new Response(Buffer.from('PNGDATA'), { status: 200, headers: { 'content-type': 'image/jpeg' } })) as any;
      const r = await runImageGeneration('flux', { prompt: 'a cat' });
      expect(r.platform).toBe('pollinations');
      expect(r.images[0].b64_json).toBe(Buffer.from('PNGDATA').toString('base64'));
    });

    it('Cloudflare: JSON {result.image} → b64_json', async () => {
      addMedia('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image');
      addKey('cloudflare', 'acct123:token456');
      globalThis.fetch = vi.fn(async () => jsonResponse({ result: { image: 'CFB64' }, success: true })) as any;
      const r = await runImageGeneration('@cf/black-forest-labs/flux-1-schnell', { prompt: 'x' });
      expect(r.images[0].b64_json).toBe('CFB64');
    });

    it('Cloudflare: binary SDXL response → b64_json', async () => {
      addMedia('cloudflare', '@cf/stabilityai/stable-diffusion-xl-base-1.0', 'image');
      addKey('cloudflare', 'acct123:token456');
      globalThis.fetch = vi.fn(async () =>
        new Response(Buffer.from('SDXLPNG'), { status: 200, headers: { 'content-type': 'image/png' } })) as any;
      const r = await runImageGeneration('@cf/stabilityai/stable-diffusion-xl-base-1.0', { prompt: 'x' });
      expect(r.images[0].b64_json).toBe(Buffer.from('SDXLPNG').toString('base64'));
    });

    it('SiliconFlow: images[].url → url', async () => {
      addMedia('siliconflow', 'black-forest-labs/FLUX.1-schnell', 'image');
      addKey('siliconflow');
      globalThis.fetch = vi.fn(async () => jsonResponse({ images: [{ url: 'https://x/y.png' }] })) as any;
      const r = await runImageGeneration('black-forest-labs/FLUX.1-schnell', { prompt: 'x' });
      expect(r.images[0].url).toBe('https://x/y.png');
    });

    it('unknown model id → 400', async () => {
      addMedia('nvidia', 'real-model', 'image');
      addKey('nvidia');
      await expect(runImageGeneration('does-not-exist', { prompt: 'x' })).rejects.toMatchObject({ status: 400 });
    });

    it('no providers configured → 503', async () => {
      await expect(runImageGeneration('auto', { prompt: 'x' })).rejects.toMatchObject({ status: 503 });
    });

    it('fails over to the next provider on error (auto)', async () => {
      addMedia('nvidia', 'flux-n', 'image', 1);
      addKey('nvidia');
      addMedia('siliconflow', 'flux-s', 'image', 2);
      addKey('siliconflow');
      globalThis.fetch = vi.fn(async (url: any) => {
        if (String(url).includes('nvidia')) return new Response('upstream boom', { status: 500 });
        return jsonResponse({ images: [{ url: 'ok' }] });
      }) as any;
      const r = await runImageGeneration('auto', { prompt: 'x' });
      expect(r.platform).toBe('siliconflow');
      expect(r.images[0].url).toBe('ok');
    });

    it('skips a provider with no key, uses the one that has it (auto)', async () => {
      addMedia('nvidia', 'flux-n', 'image', 1);   // no key added
      addMedia('siliconflow', 'flux-s', 'image', 2);
      addKey('siliconflow');
      globalThis.fetch = vi.fn(async () => jsonResponse({ images: [{ url: 'ok' }] })) as any;
      const r = await runImageGeneration('auto', { prompt: 'x' });
      expect(r.platform).toBe('siliconflow');
    });

    it('custom image models call the bound OpenAI-compatible endpoint', async () => {
      const keyId = addCustomKey('http://127.0.0.1:8282/v1', 'custom-image-key');
      addMedia('custom', 'local-image', 'image', 1, keyId);
      const fetchMock = vi.fn(async () => jsonResponse({ data: [{ url: 'https://example.test/image.png' }] }));
      globalThis.fetch = fetchMock as any;

      const r = await runImageGeneration('local-image', { prompt: 'a cat', n: 2, size: '512x512' });

      expect(r.platform).toBe('custom');
      expect(r.images[0].url).toBe('https://example.test/image.png');
      expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8282/v1/images/generations');
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer custom-image-key');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: 'local-image', prompt: 'a cat', n: 2, size: '512x512' });
      const log = getDb().prepare("SELECT key_id FROM requests WHERE request_type = 'image' ORDER BY id DESC LIMIT 1").get() as { key_id: number };
      expect(log.key_id).toBe(keyId);
    });
  });

  describe('text-to-speech', () => {
    it('Cloudflare MeloTTS: base64 audio → audio/mpeg bytes', async () => {
      addMedia('cloudflare', '@cf/myshell-ai/melotts', 'audio');
      addKey('cloudflare', 'acct:tok');
      globalThis.fetch = vi.fn(async () => jsonResponse({ result: { audio: Buffer.from('MP3').toString('base64') } })) as any;
      const r = await runSpeech('@cf/myshell-ai/melotts', { input: 'hi' });
      expect(r.contentType).toBe('audio/mpeg');
      expect(r.audio.toString()).toBe('MP3');
    });

    it('SiliconFlow CosyVoice: raw audio bytes', async () => {
      addMedia('siliconflow', 'FunAudioLLM/CosyVoice2-0.5B', 'audio');
      addKey('siliconflow');
      globalThis.fetch = vi.fn(async () =>
        new Response(Buffer.from('COSY'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) as any;
      const r = await runSpeech('FunAudioLLM/CosyVoice2-0.5B', { input: 'hi' });
      expect(r.contentType).toBe('audio/mpeg');
      expect(r.audio.toString()).toBe('COSY');
    });

    it('Pollinations openai-audio: message.audio.data → bytes (keyless)', async () => {
      addMedia('pollinations', 'openai-audio', 'audio');
      globalThis.fetch = vi.fn(async () =>
        jsonResponse({ choices: [{ message: { audio: { data: Buffer.from('POLLY').toString('base64') } } }] })) as any;
      const r = await runSpeech('openai-audio', { input: 'hi' });
      expect(r.audio.toString()).toBe('POLLY');
    });

    it('Gemini TTS: base64 PCM wrapped as WAV (RIFF header)', async () => {
      addMedia('google', 'gemini-2.5-flash-preview-tts', 'audio');
      addKey('google');
      const pcm = Buffer.from([1, 2, 3, 4]);
      globalThis.fetch = vi.fn(async () => jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
      })) as any;
      const r = await runSpeech('gemini-2.5-flash-preview-tts', { input: 'hi' });
      expect(r.contentType).toBe('audio/wav');
      expect(r.audio.subarray(0, 4).toString()).toBe('RIFF');
      expect(r.audio.subarray(8, 12).toString()).toBe('WAVE');
      // header (44) + 4 PCM bytes
      expect(r.audio.length).toBe(48);
    });

    it('custom audio models call the bound OpenAI-compatible endpoint', async () => {
      const keyId = addCustomKey('http://127.0.0.1:8383/v1', 'custom-audio-key');
      addMedia('custom', 'local-tts', 'audio', 1, keyId);
      const fetchMock = vi.fn(async () =>
        new Response(Buffer.from('MP3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) as any;
      globalThis.fetch = fetchMock as any;

      const r = await runSpeech('local-tts', { input: 'hi', voice: 'alloy', format: 'mp3' });

      expect(r.platform).toBe('custom');
      expect(r.audio.toString()).toBe('MP3');
      expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8383/v1/audio/speech');
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer custom-audio-key');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: 'local-tts', input: 'hi', voice: 'alloy', response_format: 'mp3' });
      const log = getDb().prepare("SELECT key_id FROM requests WHERE request_type = 'audio' ORDER BY id DESC LIMIT 1").get() as { key_id: number };
      expect(log.key_id).toBe(keyId);
    });
  });
});
