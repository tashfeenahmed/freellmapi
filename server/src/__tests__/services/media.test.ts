import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { runImageGeneration, runVideoGeneration, runSpeech } from '../../services/media.js';
import { registerCustomMediaModel } from '../../services/custom-media-register.js';

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

  it('skips capped provider keys and keeps a reservation until image generation completes', async () => {
    addMedia('nvidia', 'black-forest-labs/flux.1-schnell', 'image');
    addKey('nvidia', 'spent-key');
    addKey('nvidia', 'available-key');
    const db = getDb();
    const keys = db.prepare('SELECT id FROM api_keys ORDER BY id').all() as { id: number }[];
    db.prepare('UPDATE api_keys SET monthly_request_cap = 1').run();
    db.prepare(`INSERT INTO requests (platform, model_id, key_id, status, latency_ms)
      VALUES ('nvidia', 'chat-model', ?, 'success', 1)`).run(keys[0].id);
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const first = runImageGeneration('auto', { prompt: 'a cat' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer available-key');
    await expect(runImageGeneration('auto', { prompt: 'a cat' })).rejects.toMatchObject({ status: 429, code: 'quota_exceeded' });
    finish(jsonResponse({ artifacts: [{ base64: 'AAAA' }] }));
    await expect(first).resolves.toMatchObject({ platform: 'nvidia' });
    expect(db.prepare('SELECT requests FROM key_monthly_usage WHERE key_id = ?').get(keys[1].id)).toEqual({ requests: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A failed attempt does not consume another request, and cannot leak its reservation.
    db.prepare('UPDATE api_keys SET monthly_request_cap = 2 WHERE id = ?').run(keys[1].id);
    fetchMock.mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(runImageGeneration('auto', { prompt: 'a cat' })).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValue(jsonResponse({ artifacts: [{ base64: 'BBBB' }] }));
    await expect(runImageGeneration('auto', { prompt: 'a cat' })).resolves.toMatchObject({ platform: 'nvidia' });
  });

  describe('image generation', () => {
    function twoImageProviders() {
      addMedia('nvidia', 'black-forest-labs/flux.1-schnell', 'image', 1);
      addMedia('siliconflow', 'black-forest-labs/FLUX.1-schnell', 'image', 2);
      addKey('nvidia');
      addKey('siliconflow');
    }
    const limited = (ra?: string) => new Response('slow down', { status: 429, headers: ra ? { 'retry-after': ra } : {} });
    const byHost = (nvidia: () => Response, siliconflow: () => Response) =>
      vi.fn(async (url: string) => (String(url).includes('siliconflow') ? siliconflow() : nvidia())) as any;

    it('relays the SOONEST Retry-After when every provider is rate-limited', async () => {
      twoImageProviders();
      globalThis.fetch = byHost(() => limited('5'), () => limited('60'));
      await expect(runImageGeneration('auto', { prompt: 'a cat' })).rejects.toMatchObject({ status: 429, retryAfterMs: 5_000 });
    });

    it('drops the hint when a rate-limited provider stated no delay', async () => {
      twoImageProviders();
      globalThis.fetch = byHost(() => limited('17'), () => limited());
      const err = await runImageGeneration('auto', { prompt: 'a cat' }).catch(e => e);
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBeUndefined();
    });

    it('drops the hint when the chain ends in a non-rate-limit failure', async () => {
      twoImageProviders();
      globalThis.fetch = byHost(() => limited('17'), () => new Response('boom', { status: 500 }));
      const err = await runImageGeneration('auto', { prompt: 'a cat' }).catch(e => e);
      expect(err.status).toBe(502);
      expect(err.retryAfterMs).toBeUndefined();
    });

    it('fails over past a rate-limited provider', async () => {
      twoImageProviders();
      globalThis.fetch = byHost(() => limited('17'), () => jsonResponse({ images: [{ url: 'https://x/y.png' }] }));
      await expect(runImageGeneration('auto', { prompt: 'a cat' })).resolves.toMatchObject({ platform: 'siliconflow' });
    });

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

    it('fails over between endpoints sharing an image model id with their own keys', async () => {
      const first = addCustomKey('http://127.0.0.1:8282/v1', 'first-key');
      const second = addCustomKey('http://127.0.0.1:8383/v1', 'second-key');
      for (const key of [first, second]) {
        registerCustomMediaModel(getDb(), key, { modelId: 'shared-image', displayName: null, modality: 'image' });
      }
      const fetchMock = vi.fn(async (url: string) => String(url).includes(':8282/')
        ? new Response('unavailable', { status: 503 })
        : jsonResponse({ data: [{ url: 'https://example.test/image.png' }] }));
      globalThis.fetch = fetchMock as any;
      await expect(runImageGeneration('shared-image', { prompt: 'a cat' })).resolves.toMatchObject({
        images: [{ url: 'https://example.test/image.png' }],
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
      expect(String(calls[0][0])).toContain(':8282/');
      expect(new Headers(calls[0][1].headers).get('Authorization')).toBe('Bearer first-key');
      expect(String(calls[1][0])).toContain(':8383/');
      expect(new Headers(calls[1][1].headers).get('Authorization')).toBe('Bearer second-key');
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
    const freeAiUrl = 'https://api.free.ai/static/outputs/1bcc722e-4ddf-4e15-995a-b274000f99e5.wav';
    const freeAiWav = () => { const b = Buffer.alloc(48); b.write('RIFF'); b.write('WAVE', 8); return b; };

    it('Free.ai maps OpenAI fields to Kokoro and downloads verified WAV without credentials', async () => {
      addMedia('freeai', 'kokoro', 'audio'); addKey('freeai');
      const wav = freeAiWav();
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ audio_url: freeAiUrl }))
        .mockResolvedValueOnce(new Response(wav, { headers: { 'Content-Type': 'audio/wav' } }));
      const result = await runSpeech('kokoro', { input: 'Hello', voice: 'alloy' });
      expect(result.audio).toEqual(wav);
      expect(result.contentType).toBe('audio/wav');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.free.ai/v1/tts/');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer freeai-test-key');
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'kokoro', text: 'Hello', voice: 'af_heart' });
      expect(fetchMock.mock.calls[1][0]).toBe(freeAiUrl);
      expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has('Authorization')).toBe(false);
      for (const [, request] of fetchMock.mock.calls) expect(request?.redirect).toBe('error');
    });

    it('Free.ai preserves native voices and explicit WAV requests', async () => {
      addMedia('freeai', 'kokoro', 'audio'); addKey('freeai');
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(jsonResponse({ audio_url: freeAiUrl }))
        .mockResolvedValueOnce(new Response(freeAiWav()));
      await runSpeech('kokoro', { input: 'Hello', voice: 'af_heart', format: 'wav' });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).voice).toBe('af_heart');
    });

    it.each(['mp3', 'pcm', 'flac', 'opus'])('Free.ai rejects unsupported %s before generating', async format => {
      addMedia('freeai', 'kokoro', 'audio'); addKey('freeai');
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      await expect(runSpeech('kokoro', { input: 'Hello', format })).rejects.toThrow('supports wav');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Free.ai never sends untested or premium model IDs', async () => {
      addMedia('freeai', 'premium/voice', 'audio'); addKey('freeai');
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      await expect(runSpeech('premium/voice', { input: 'Hello' })).rejects.toThrow('only the tested Kokoro');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([{}, { audio_url: 'http://169.254.169.254/latest/meta-data/' }, { audio_url: 'https://example.com/test.wav' }])('Free.ai never downloads unsafe output', async body => {
      addMedia('freeai', 'kokoro', 'audio'); addKey('freeai');
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));
      await expect(runSpeech('kokoro', { input: 'Hello' })).rejects.toThrow('unsafe audio URL');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('Free.ai rejects JSON and oversized output instead of labelling them audio', async () => {
      addMedia('freeai', 'kokoro', 'audio'); addKey('freeai');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ audio_url: freeAiUrl }))
        .mockResolvedValueOnce(jsonResponse({ error: 'not audio' }))
        .mockResolvedValueOnce(jsonResponse({ audio_url: freeAiUrl }))
        .mockResolvedValueOnce(new Response(freeAiWav(), { headers: { 'Content-Length': String(21 * 1024 * 1024) } }));
      await expect(runSpeech('kokoro', { input: 'Hello' })).rejects.toThrow('recognized WAV');
      await expect(runSpeech('kokoro', { input: 'Hello' })).rejects.toThrow('too large');
    });

    it('Free.ai preserves quota backoff without retrying a paid model', async () => {
      addMedia('freeai', 'kokoro', 'audio'); addKey('freeai');
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('quota', { status: 429, headers: { 'Retry-After': '30' } }));
      await expect(runSpeech('kokoro', { input: 'Hello' })).rejects.toMatchObject({ status: 429, retryAfterMs: 30000 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('Free.ai reports queued work without following a poll URL or resubmitting generation', async () => {
      addMedia('freeai', 'kokoro', 'audio'); addKey('freeai');
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ queued: true, job_id: 'test', poll_url: 'https://example.com/private' }));
      await expect(runSpeech('kokoro', { input: 'Hello' })).rejects.toMatchObject({ status: 502, code: 'upstream_queued' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['simba-3.0', 'simba-3.2'])('Speechify %s sends native fields and decodes JSON audio', async model => {
      addMedia('speechify', model, 'audio');
      addKey('speechify');
      const audio = Buffer.from('ID3test-audio');
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ audio_data: audio.toString('base64'), audio_format: 'mp3', billable_characters_count: 5 }));
      const result = await runSpeech(model, { input: 'Hello', voice: 'alloy' });
      expect(result.audio).toEqual(audio);
      expect(result.contentType).toBe('audio/mpeg');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.speechify.ai/v1/audio/speech');
      expect(new Headers(init?.headers).get('Speechify-Version')).toBe('2026-09-08');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer speechify-test-key');
      expect(JSON.parse(String(init?.body))).toEqual({ model, input: 'Hello', voice_id: 'alec', audio_format: 'mp3' });
    });

    it('Speechify preserves native voices and requested supported formats', async () => {
      addMedia('speechify', 'test-simba', 'audio'); addKey('speechify');
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ audio_data: 'T2dnUw==', audio_format: 'ogg' }));
      const result = await runSpeech('test-simba', { input: 'Hello', voice: 'native-voice-id', format: 'ogg' });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ voice_id: 'native-voice-id', audio_format: 'ogg' });
      expect(result.contentType).toBe('audio/ogg');
    });

    it.each(['pcm', 'flac', 'opus'])('Speechify rejects unsupported %s without sending a request', async format => {
      addMedia('speechify', 'test-simba', 'audio'); addKey('speechify');
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      await expect(runSpeech('test-simba', { input: 'Hello', format })).rejects.toThrow('Speechify supports');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([{}, { audio_data: 'not base64', audio_format: 'mp3' }, { audio_data: '', audio_format: 'mp3' }, { audio_data: 'SUQz', audio_format: 'wav' }])('Speechify rejects malformed audio instead of returning JSON as sound', async body => {
      addMedia('speechify', 'test-simba', 'audio'); addKey('speechify');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));
      await expect(runSpeech('test-simba', { input: 'Hello' })).rejects.toThrow('Speechify returned');
    });

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

    it.each(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'])('Gemini TTS: passes through existing WAV bytes for %s', async model => {
      addMedia('google', model, 'audio');
      addKey('google');
      const wav = Buffer.alloc(48);
      wav.write('RIFF', 0); wav.writeUInt32LE(40, 4); wav.write('WAVE', 8);
      wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
      globalThis.fetch = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] } }] }));
      const result = await runSpeech(model, { input: 'hello' });
      expect(result.audio).toEqual(wav);
      expect(result.contentType).toBe('audio/wav');
    });

    it('Gemini TTS: rejects an invalid declared WAV rather than wrapping it as PCM', async () => {
      addMedia('google', 'gemini-3.8-flash-tts', 'audio');
      addKey('google');
      globalThis.fetch = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from('not audio').toString('base64') } }] } }] }));
      await expect(runSpeech('gemini-3.8-flash-tts', { input: 'hello' })).rejects.toThrow('malformed WAV');
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
