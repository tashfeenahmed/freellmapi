import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PollinationsImageProvider } from '../../providers/pollinations-image.js';

describe('PollinationsImageProvider', () => {
  let provider: PollinationsImageProvider;

  beforeEach(() => {
    provider = new PollinationsImageProvider();
    vi.restoreAllMocks();
  });

  it('has correct platform, name and keyless flag', () => {
    expect(provider.platform).toBe('pollinations-image');
    expect(provider.name).toBe('Pollinations (Image)');
    expect(provider.keyless).toBe(true);
    expect(provider.supportsImages()).toBe(true);
  });

  describe('generateImage — url format (default)', () => {
    it('returns a deterministic URL without calling upstream', async () => {
      // url format is lazy: no network call should happen — the URL is built
      // locally so we don't burn the 1-concurrent anonymous slot.
      const fetchSpy = vi.spyOn(global, 'fetch');

      const result = await provider.generateImage('', {
        prompt: 'a red panda',
        seed: 42,
        size: '512x512',
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].url).toContain('https://image.pollinations.ai/prompt/');
      expect(result.data[0].url).toContain('a%20red%20panda');
      expect(result.data[0].url).toContain('model=sana');
      expect(result.data[0].url).toContain('width=512');
      expect(result.data[0].url).toContain('height=512');
      expect(result.data[0].url).toContain('seed=42');
      expect(result.data[0].url).toContain('nologo=true');
      expect(result.data[0].b64_json).toBeUndefined();
      expect(result._routed_via).toEqual({ platform: 'pollinations-image', model: 'sana' });
    });

    it('defaults to model "sana" — the only model on the anonymous /models list', async () => {
      const result = await provider.generateImage('', { prompt: 'test' });
      expect(result.data[0].url).toContain('model=sana');
      expect(result._routed_via?.model).toBe('sana');
    });

    it('honors a custom model name (e.g. for future-added models)', async () => {
      const result = await provider.generateImage('', { prompt: 'test', model: 'flux' });
      expect(result.data[0].url).toContain('model=flux');
      expect(result._routed_via?.model).toBe('flux');
    });

    it('treats model="auto" as default (sana)', async () => {
      const result = await provider.generateImage('', { prompt: 'test', model: 'auto' });
      expect(result.data[0].url).toContain('model=sana');
    });

    it('defaults size to 1024x1024 when omitted', async () => {
      const result = await provider.generateImage('', { prompt: 'test' });
      expect(result.data[0].url).toContain('width=1024');
      expect(result.data[0].url).toContain('height=1024');
    });

    it('encodes prompts with special characters safely', async () => {
      const result = await provider.generateImage('', {
        prompt: 'a cat & dog, 100% cute',
        seed: 1,
      });
      // Verify the encoded form decodes back to the original
      const url = new URL(result.data[0].url!);
      const decoded = decodeURIComponent(url.pathname.replace('/prompt/', ''));
      expect(decoded).toBe('a cat & dog, 100% cute');
    });
  });

  describe('generateImage — b64_json format', () => {
    it('downloads the image and returns base64', async () => {
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG magic
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(fakeJpeg.buffer.slice(fakeJpeg.byteOffset, fakeJpeg.byteOffset + fakeJpeg.byteLength)),
        headers: { get: () => null },
      } as any);

      const result = await provider.generateImage('', {
        prompt: 'tiny',
        response_format: 'b64_json',
        size: '256x256',
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].b64_json).toBe(fakeJpeg.toString('base64'));
      expect(result.data[0].url).toBeUndefined();
    });

    it('maps upstream 402 to a clear error with status preserved', async () => {
      // Live-probed: Pollinations returns 402 when the anonymous 1-concurrent
      // limit is hit. providerHttpError must preserve the status so the route
      // layer can map it to OpenAI's rate_limit_error type.
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 402,
        statusText: 'Payment Required',
        headers: { get: () => null },
        json: () => Promise.resolve({}),
      } as any);

      await expect(
        provider.generateImage('', { prompt: 'x', response_format: 'b64_json' }),
      ).rejects.toMatchObject({
        status: 402,
        message: expect.stringMatching(/concurrent request limit/i),
      });
    });

    it('surfaces non-402 upstream errors with their status', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: () => null },
        json: () => Promise.resolve({}),
      } as any);

      await expect(
        provider.generateImage('', { prompt: 'x', response_format: 'b64_json' }),
      ).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  describe('generateImage — validation', () => {
    it('rejects empty prompt', async () => {
      await expect(provider.generateImage('', { prompt: '' })).rejects.toThrow(/prompt is required/);
      await expect(provider.generateImage('', { prompt: '   ' })).rejects.toThrow(/prompt is required/);
    });

    it('rejects n>1 with status 400 (Pollinations anon tier is 1-concurrent)', async () => {
      // We intentionally do not fan out server-side: 1-concurrent per IP makes
      // it unreliable, OpenAI clients can loop themselves.
      await expect(
        provider.generateImage('', { prompt: 'multi', n: 2 }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/n=1 only/),
      });

      await expect(
        provider.generateImage('', { prompt: 'multi', n: 4 }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('accepts n=1 explicitly', async () => {
      const result = await provider.generateImage('', { prompt: 'single', n: 1 });
      expect(result.data).toHaveLength(1);
    });
  });

  describe('chat methods (image-only adapter)', () => {
    it('throws on chatCompletion', async () => {
      await expect((provider as any).chatCompletion()).rejects.toThrow(/image-only/);
    });

    it('throws on streamChatCompletion', async () => {
      const gen = (provider as any).streamChatCompletion();
      await expect(gen.next()).rejects.toThrow(/image-only/);
    });
  });

  describe('validateKey', () => {
    it('probes /models cheaply and returns true on 200', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
      } as any);

      expect(await provider.validateKey('')).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = (fetchSpy.mock.calls[0][0] as string);
      expect(url).toBe('https://image.pollinations.ai/models');
    });

    it('returns false when /models is unreachable', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => null },
      } as any);

      expect(await provider.validateKey('')).toBe(false);
    });
  });
});
