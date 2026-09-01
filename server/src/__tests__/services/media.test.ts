import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runImageGeneration, runVideoGeneration, runSpeech, MediaError } from '../../services/media.js';

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

function addMedia(
  platform: string,
  modelId: string,
  modality: 'image' | 'video' | 'audio',
  priority = 1,
  keyId: number | null = null,
  metaJson: string | null = null,
) {
  getDb().prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, meta_json)
    VALUES (?, ?, ?, ?, ?, 1, '', ?, ?)
  `).run(platform, modelId, modelId, modality, priority, keyId, metaJson);
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

    it('NVIDIA FLUX.1 Dev: sends the validated 28-step 1024x1024 payload', async () => {
      addMedia('nvidia', 'black-forest-labs/flux.1-dev', 'image');
      addKey('nvidia');
      const fetchMock = vi.fn(async () => jsonResponse({ artifacts: [{ base64: 'DEV' }] }));
      globalThis.fetch = fetchMock as any;

      await runImageGeneration('black-forest-labs/flux.1-dev', {
        prompt: 'a lighthouse',
        size: '512x512',
      });

      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body).toEqual({
        prompt: 'a lighthouse',
        mode: 'base',
        steps: 28,
        width: 1024,
        height: 1024,
        cfg_scale: 3.5,
      });
    });

    it('NVIDIA FLUX.2 Klein 4B: omits unsupported mode and guidance fields', async () => {
      addMedia('nvidia', 'black-forest-labs/flux.2-klein-4b', 'image');
      addKey('nvidia');
      const fetchMock = vi.fn(async () => jsonResponse({ artifacts: [{ base64: 'KLEIN' }] }));
      globalThis.fetch = fetchMock as any;

      await runImageGeneration('black-forest-labs/flux.2-klein-4b', {
        prompt: 'a red kite',
        size: '512x512',
      });

      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body).toEqual({ prompt: 'a red kite', steps: 4, width: 1024, height: 1024 });
      expect(body).not.toHaveProperty('mode');
      expect(body).not.toHaveProperty('guidance');
      expect(body).not.toHaveProperty('cfg_scale');
    });

    it('Pollinations: keyless GET, raw bytes → b64_json (no api key needed)', async () => {
      addMedia('pollinations', 'flux', 'image');
      globalThis.fetch = vi.fn(async () =>
        new Response(Buffer.from('PNGDATA'), { status: 200, headers: { 'content-type': 'image/jpeg' } })) as any;
      const r = await runImageGeneration('flux', { prompt: 'a cat' });
      expect(r.platform).toBe('pollinations');
      expect(r.images[0].b64_json).toBe(Buffer.from('PNGDATA').toString('base64'));
    });

    it('Cloudflare FLUX.1 Schnell: sends only the prompt and maps result.image', async () => {
      addMedia('cloudflare', '@cf/black-forest-labs/flux-1-schnell', 'image');
      addKey('cloudflare', 'acct123:token456');
      const fetchMock = vi.fn(async () => jsonResponse({ result: { image: 'CFB64' }, success: true }));
      globalThis.fetch = fetchMock as any;
      const r = await runImageGeneration('@cf/black-forest-labs/flux-1-schnell', { prompt: 'x' });
      expect(r.images[0].b64_json).toBe('CFB64');
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(JSON.parse(String(init.body))).toEqual({ prompt: 'x' });
    });

    it('Cloudflare: requestStyle multipart sends form-data (FLUX.2 rejects JSON)', async () => {
      addMedia('cloudflare', '@cf/black-forest-labs/flux-2-klein-4b', 'image', 1, null,
        JSON.stringify({ requestStyle: 'multipart' }));
      addKey('cloudflare', 'acct123:token456');
      const fetchMock = vi.fn(async () => jsonResponse({ result: { image: 'KLEINB64' }, success: true }));
      globalThis.fetch = fetchMock as any;
      const r = await runImageGeneration('@cf/black-forest-labs/flux-2-klein-4b', {
        prompt: 'a small blue square',
        size: '512x512',
      });
      expect(r.images[0].b64_json).toBe('KLEINB64');
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(form.get('prompt')).toBe('a small blue square');
      expect(form.get('width')).toBe('512');
      expect(form.get('height')).toBe('512');
      // Content-Type must stay unset so fetch supplies the multipart boundary.
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
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

  describe('video generation', () => {
    it('Pollinations: sends the authenticated nova-reel request and returns MP4 bytes', async () => {
      addMedia('pollinations', 'nova-reel', 'video');
      addKey('pollinations', 'sk_pollinations_test');
      const fetchMock = vi.fn(async () =>
        new Response(Buffer.from('MP4DATA'), { status: 200, headers: { 'content-type': 'video/mp4' } }));
      globalThis.fetch = fetchMock as any;

      const result = await runVideoGeneration('nova-reel', {
        prompt: 'sunrise over a lake',
        duration: 12,
        aspectRatio: '16:9',
        seed: 7,
      });

      expect(result.platform).toBe('pollinations');
      expect(result.video.toString()).toBe('MP4DATA');
      expect(result.contentType).toBe('video/mp4');
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toBe('/video/sunrise%20over%20a%20lake');
      expect(url.searchParams.get('model')).toBe('nova-reel');
      expect(url.searchParams.get('duration')).toBe('12');
      expect(url.searchParams.get('aspectRatio')).toBe('16:9');
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer sk_pollinations_test',
      });
    });

    it('Pollinations: omits duration entirely when the caller did not ask for one', async () => {
      // Allowed lengths differ per model (nova-reel 6-120 by 6, veo 4/6/8,
      // minimax-h3 exactly 5), so guessing one would 400 on most of the
      // roster. No duration means the provider uses the model's own default.
      addMedia('pollinations', 'nova-reel', 'video');
      addKey('pollinations', 'sk_pollinations_test');
      const fetchMock = vi.fn(async () =>
        new Response(Buffer.from('MP4DATA'), { status: 200, headers: { 'content-type': 'video/mp4' } }));
      globalThis.fetch = fetchMock as any;

      await runVideoGeneration('nova-reel', { prompt: 'sunrise over a lake' });

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.searchParams.has('duration')).toBe(false);
      expect(url.searchParams.get('model')).toBe('nova-reel');
    });

    it('Pollinations: rejects unsupported nova-reel durations before calling upstream', async () => {
      addMedia('pollinations', 'nova-reel', 'video');
      addKey('pollinations');
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as any;

      await expect(runVideoGeneration('nova-reel', {
        prompt: 'x',
        duration: 7,
      })).rejects.toMatchObject({ status: 400 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Hugging Face: submits and resolves the fal.ai queue without leaking the token to the media URL', async () => {
      addMedia(
        'huggingface',
        'Lightricks/LTX-Video-0.9.5',
        'video',
        1,
        null,
        JSON.stringify({ providerModelId: 'fal-ai/ltx-video-v095' }),
      );
      addKey('huggingface', 'hf_test_token');
      // The submit is answered with a job that is still queued, so the poll
      // loop actually runs: an unmatched URL is a hard failure rather than
      // falling through to a canned COMPLETED reply.
      const submitUrl = 'https://router.huggingface.co/fal-ai/fal-ai/ltx-video-v095?_subdomain=queue';
      const jobUrl = 'https://router.huggingface.co/fal-ai/fal-ai/ltx-video-v095/requests/job-1?_subdomain=queue';
      const statusUrl = 'https://router.huggingface.co/fal-ai/fal-ai/ltx-video-v095/requests/job-1/status?_subdomain=queue';
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === submitUrl) {
          return jsonResponse({
            request_id: 'job-1',
            status: 'IN_QUEUE',
            response_url: 'https://queue.fal.run/fal-ai/ltx-video-v095/requests/job-1',
          });
        }
        if (url === statusUrl) return jsonResponse({ status: 'COMPLETED' });
        if (url === jobUrl) {
          return jsonResponse({ video: { url: 'https://cdn.example.test/video.mp4', content_type: 'video/mp4' } });
        }
        if (url === 'https://cdn.example.test/video.mp4') {
          return new Response(Buffer.from('HFVIDEO'), { status: 200, headers: { 'content-type': 'video/mp4' } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      globalThis.fetch = fetchMock as any;

      const result = await runVideoGeneration('Lightricks/LTX-Video-0.9.5', {
        prompt: 'paper boats on a stream',
        seed: 42,
      });

      expect(result.video.toString()).toBe('HFVIDEO');
      expect(fetchMock.mock.calls.map(c => String(c[0]))).toEqual([
        submitUrl,
        statusUrl,
        jobUrl,
        'https://cdn.example.test/video.mp4',
      ]);
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
        prompt: 'paper boats on a stream',
        seed: 42,
      });
      // The status and result reads are authenticated; the CDN download is not,
      // so the HF token never reaches a host named by an upstream response.
      expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer hf_test_token',
      });
      expect((fetchMock.mock.calls[3][1] as RequestInit).headers).toBeUndefined();
    });

    it('stops the chain when the API caller hangs up instead of paying for a second provider', async () => {
      addMedia('pollinations', 'nova-reel', 'video', 1);
      addMedia('pollinations', 'wan-fast', 'video', 2);
      addKey('pollinations', 'sk_pollinations_test');
      const controller = new AbortController();
      const fetchMock = vi.fn(async () => {
        controller.abort();
        throw new Error('socket hang up');
      });
      globalThis.fetch = fetchMock as any;

      await expect(runVideoGeneration('auto', { prompt: 'x' }, controller.signal))
        .rejects.toMatchObject({ status: 499 });
      // The second catalogued provider is never attempted.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports an upstream key rejection as an upstream failure, not a caller auth error', async () => {
      // A 401 from the provider means the OPERATOR's key was refused. Passing
      // it to the caller would tell an OpenAI SDK that its own gateway key is
      // bad; a caller-attributable 400 does travel through.
      addMedia('pollinations', 'nova-reel', 'video');
      addKey('pollinations', 'sk_pollinations_test');
      globalThis.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as any;
      await expect(runVideoGeneration('nova-reel', { prompt: 'x' }))
        .rejects.toMatchObject({ status: 502 });

      globalThis.fetch = vi.fn(async () => new Response('bad prompt', { status: 400 })) as any;
      await expect(runVideoGeneration('nova-reel', { prompt: 'x' }))
        .rejects.toMatchObject({ status: 400 });
    });

    it('Hugging Face: refuses a result URL that points at a blocked address class', async () => {
      // The result URL is the one URL in this adapter that comes out of an
      // upstream JSON body, so it goes through the same guard custom-provider
      // base URLs do (#440) instead of being fetched and streamed back.
      addMedia(
        'huggingface',
        'Lightricks/LTX-Video-0.9.5',
        'video',
        1,
        null,
        JSON.stringify({ providerModelId: 'fal-ai/ltx-video-v095' }),
      );
      addKey('huggingface', 'hf_test_token');
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('requests/job-1?_subdomain=queue')) {
          return jsonResponse({ video: { url: 'http://169.254.169.254/latest/meta-data/' } });
        }
        return jsonResponse({
          request_id: 'job-1',
          status: 'COMPLETED',
          response_url: 'https://queue.fal.run/fal-ai/ltx-video-v095/requests/job-1',
        });
      });
      globalThis.fetch = fetchMock as any;

      await expect(runVideoGeneration('Lightricks/LTX-Video-0.9.5', { prompt: 'x' }))
        .rejects.toThrow(/unusable video URL/);
      // Submit + result read only; the metadata address was never contacted.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('text-to-speech', () => {
    it('Cloudflare MeloTTS: base64 audio → audio/mpeg bytes', async () => {
      addMedia('cloudflare', '@cf/myshell-ai/melotts', 'audio');
      addKey('cloudflare', 'acct:tok');
      const fetchMock = vi.fn(async () => jsonResponse({ result: { audio: Buffer.from('MP3').toString('base64') } }));
      globalThis.fetch = fetchMock as any;
      const r = await runSpeech('@cf/myshell-ai/melotts', { input: 'hi', voice: 'alloy' });
      expect(r.contentType).toBe('audio/mpeg');
      expect(r.audio.toString()).toBe('MP3');
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body).toMatchObject({ prompt: 'hi', lang: 'en' });
    });

    it('SiliconFlow CosyVoice: maps OpenAI voices, accepts native names, and defaults unknown names', async () => {
      addMedia('siliconflow', 'FunAudioLLM/CosyVoice2-0.5B', 'audio');
      addKey('siliconflow');
      const fetchMock = vi.fn(async () =>
        new Response(Buffer.from('COSY'), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
      globalThis.fetch = fetchMock as any;
      const r = await runSpeech('FunAudioLLM/CosyVoice2-0.5B', { input: 'hi', voice: 'nova' });
      await runSpeech('FunAudioLLM/CosyVoice2-0.5B', { input: 'hi', voice: 'diana' });
      await runSpeech('FunAudioLLM/CosyVoice2-0.5B', { input: 'hi', voice: 'not-a-voice' });
      expect(r.contentType).toBe('audio/mpeg');
      expect(r.audio.toString()).toBe('COSY');
      const voices = fetchMock.mock.calls.map(call =>
        JSON.parse(String((call[1] as RequestInit).body)).voice,
      );
      expect(voices).toEqual([
        'FunAudioLLM/CosyVoice2-0.5B:anna',
        'FunAudioLLM/CosyVoice2-0.5B:diana',
        'FunAudioLLM/CosyVoice2-0.5B:alex',
      ]);
    });

    it('Pollinations openai-audio: keeps OpenAI voices and defaults unknown names (keyless)', async () => {
      addMedia('pollinations', 'openai-audio', 'audio');
      const fetchMock = vi.fn(async () =>
        jsonResponse({ choices: [{ message: { audio: { data: Buffer.from('POLLY').toString('base64') } } }] }));
      globalThis.fetch = fetchMock as any;
      const r = await runSpeech('openai-audio', { input: 'hi', voice: 'shimmer' });
      await runSpeech('openai-audio', { input: 'hi', voice: 'not-a-voice' });
      expect(r.audio.toString()).toBe('POLLY');
      const voices = fetchMock.mock.calls.map(call =>
        JSON.parse(String((call[1] as RequestInit).body)).audio.voice,
      );
      expect(voices).toEqual(['shimmer', 'alloy']);
    });

    it('Gemini TTS: maps OpenAI voices and wraps base64 PCM as WAV', async () => {
      addMedia('google', 'gemini-2.5-flash-preview-tts', 'audio');
      addKey('google');
      const pcm = Buffer.from([1, 2, 3, 4]);
      const fetchMock = vi.fn(async () => jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
      }));
      globalThis.fetch = fetchMock as any;
      const r = await runSpeech('gemini-2.5-flash-preview-tts', { input: 'hi', voice: 'alloy' });
      expect(r.contentType).toBe('audio/wav');
      expect(r.audio.subarray(0, 4).toString()).toBe('RIFF');
      expect(r.audio.subarray(8, 12).toString()).toBe('WAVE');
      // header (44) + 4 PCM bytes
      expect(r.audio.length).toBe(48);
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Schedar');
    });

    it('Gemini TTS: canonicalizes native voices and defaults unknown names', async () => {
      addMedia('google', 'gemini-2.5-flash-preview-tts', 'audio');
      addKey('google');
      const pcm = Buffer.from([1, 2]);
      const fetchMock = vi.fn(async () => jsonResponse({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm.toString('base64') } }] } }],
      }));
      globalThis.fetch = fetchMock as any;

      await runSpeech('gemini-2.5-flash-preview-tts', { input: 'hi', voice: 'achernar' });
      await runSpeech('gemini-2.5-flash-preview-tts', { input: 'hi', voice: 'not-a-voice' });

      const voices = fetchMock.mock.calls.map(call => {
        const body = JSON.parse(String((call[1] as RequestInit).body));
        return body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
      });
      expect(voices).toEqual(['Achernar', 'Kore']);
    });

    it('uses provider-safe voices during failover without losing a native Gemini voice', async () => {
      addMedia('cloudflare', '@cf/myshell-ai/melotts', 'audio', 1);
      addKey('cloudflare', 'acct:tok');
      addMedia('google', 'gemini-2.5-flash-preview-tts', 'audio', 2);
      addKey('google');
      const pcm = Buffer.from([1, 2]);
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('cloudflare.com')) {
          return new Response('temporarily unavailable', { status: 503 });
        }
        return jsonResponse({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: pcm.toString('base64') } }] } }],
        });
      });
      globalThis.fetch = fetchMock as any;

      const result = await runSpeech('auto', { input: 'hi', voice: 'achernar' });

      expect(result.platform).toBe('google');
      const cloudflareBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      const googleBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
      expect(cloudflareBody.lang).toBe('en');
      expect(googleBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Achernar');
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
