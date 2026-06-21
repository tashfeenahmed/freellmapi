import type {
  ImageGenerationRequest,
  ImageGenerationResponse,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError } from './base.js';

/**
 * Pollinations image generation provider (keyless, anonymous tier).
 *
 * Endpoint: GET https://image.pollinations.ai/prompt/{prompt}?model=...&width=...&height=...
 *
 * Live-probed 2026-06-16:
 *  - GET /models lists ["sana"] — the single model on the anonymous tier
 *  - sequential requests: 200 OK (probed 5/5 at 1s apart)
 *  - concurrent requests: 2/3 returned HTTP 402 "Payment Required"
 *    (Pollinations has moved authenticated traffic to a paid "Pollen" tier;
 *    anonymous access is still explicitly free but 1-concurrent per IP)
 *  - response header x-auth-status: unauthenticated confirms free tier
 *  - response header x-model-used confirms the actual model served
 *
 * Multi-image (n>1) requests are rejected with a clear error rather than
 * looped server-side: the 1-concurrent limit makes fan-out unreliable, and
 * OpenAI clients can loop multiple single-image calls themselves with their
 * own pacing. This keeps the adapter honest about what the upstream supports.
 *
 * Chat methods deliberately throw — this adapter is image-only. The platform
 * is registered as 'pollinations-image' (separate from 'pollinations' text)
 * so the existing text catalog stays untouched.
 */
export class PollinationsImageProvider extends BaseProvider {
  readonly platform = 'pollinations-image' as const;
  readonly name = 'Pollinations (Image)';
  keyless = true;

  async chatCompletion(): Promise<never> {
    throw new Error('Pollinations (Image) is image-only; use /v1/images/generations');
  }

  async *streamChatCompletion(): AsyncGenerator<never> {
    throw new Error('Pollinations (Image) is image-only; use /v1/images/generations');
  }

  async validateKey(_apiKey: string): Promise<boolean> {
    // Keyless: a GET to the model list is cheap and confirms reachability.
    // Returns ["sana"] when healthy (live-probed 2026-06-16).
    const res = await this.fetchWithTimeout(
      'https://image.pollinations.ai/models',
      { method: 'GET' },
      10000,
    );
    return res.ok;
  }

  supportsImages(): boolean { return true; }

  async generateImage(
    _apiKey: string,
    req: ImageGenerationRequest,
  ): Promise<ImageGenerationResponse> {
    const prompt = req.prompt?.trim();
    if (!prompt) throw new Error('prompt is required');

    // Reject n>1: see class comment. OpenAI clients should loop themselves
    // if they want multiple images.
    const n = req.n ?? 1;
    if (n !== 1) {
      const err = new Error('Pollinations supports n=1 only; call /v1/images/generations multiple times for multiple images') as Error & { status?: number };
      err.status = 400;
      throw err;
    }

    // Default to the only model the anonymous /models endpoint advertises.
    // Other model names (e.g. "flux") currently return 200 too, but without
    // x-model-used confirming they were honored — likely silent fallback to
    // sana. Keep the default honest.
    const model = (req.model && req.model !== 'auto') ? req.model : 'sana';

    // size: "WIDTHxHEIGHT" → individual params. Default 1024x1024.
    let width = 1024, height = 1024;
    if (typeof req.size === 'string' && /^\d+x\d+$/.test(req.size)) {
      const [w, h] = req.size.split('x').map(Number);
      width = w; height = h;
    }

    const seed = typeof req.seed === 'number' ? req.seed : Math.floor(Math.random() * 1_000_000_000);
    const format: 'url' | 'b64_json' = req.response_format === 'b64_json' ? 'b64_json' : 'url';

    const params = new URLSearchParams({
      model,
      width: String(width),
      height: String(height),
      seed: String(seed),
      nologo: 'true',
    });
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;

    if (format === 'url') {
      // Lazy: hand the URL back. Pollinations URLs are deterministic given
      // prompt+seed, so the client can fetch on demand. No upstream call here
      // means no chance to trip the 1-concurrent limit on the proxy.
      return {
        created: Math.floor(Date.now() / 1000),
        data: [{ url }],
        _routed_via: { platform: 'pollinations-image', model },
      };
    }

    // Eager: download, base64-encode. 60s timeout — sana cold starts can be slow.
    const res = await this.fetchWithTimeout(url, { method: 'GET' }, 60000);
    if (!res.ok) {
      // 402 = anonymous concurrent limit hit (live-probed). Preserve the upstream
      // status so the route layer can map it to OpenAI's rate_limit_error type.
      const hint = res.status === 402
        ? 'concurrent request limit reached — Pollinations anonymous tier allows 1 concurrent image request per IP'
        : res.statusText;
      throw providerHttpError(res, `Pollinations image error ${res.status}: ${hint}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: buf.toString('base64') }],
      _routed_via: { platform: 'pollinations-image', model },
    };
  }
}
