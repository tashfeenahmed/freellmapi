import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveProvider } from '../../providers/index.js';
import { CloudflareProvider } from '../../providers/cloudflare.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

// Regression guard for the 2026-07-11 live-sweep finding: platforms hosting
// hidden-reasoning or buffered non-streaming models (zhipu glm-4.7-flash 41s
// TTFB, agnes-2.0-flash 20s, OpenRouter/OpenCode/Mistral long generations,
// @cf/zai-org/glm-4.7-flash repeated 15s aborts) need a chat timeout above
// 15s or every attempt — streaming included — is aborted before the first byte.
// The value is a private construction detail, so the
// registry entries are asserted via the stored field and Cloudflare via the
// setTimeout the abort rides on.

describe('reasoning-model chat timeouts', () => {
  afterEach(() => {
    delete process.env.PROVIDER_STREAM_STALL_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  function sseResponse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return { ok: true, body: stream, headers: new Headers() } as Response;
  }

  async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
    const out: ChatCompletionChunk[] = [];
    for await (const chunk of gen) out.push(chunk);
    return out;
  }

  it.each([
    ['mistral', 60_000],
    ['nvidia', 180_000],
    ['openrouter', 60_000],
    ['zhipu', 60_000],
    ['agnes', 60_000],
    ['opencode', 60_000],
    ['ollama', 120_000], // pre-existing bump; keep it from regressing too
  ] as const)('%s is registered with a %dms chat timeout', (platform, ms) => {
    const provider = resolveProvider(platform);
    expect(provider).toBeDefined();
    expect((provider as unknown as { timeoutMs: number }).timeoutMs).toBe(ms);
  });

  it('cloudflare GLM 4.7 Flash gets its live-verified 200s per-model timeout', async () => {
    const provider = new CloudflareProvider();
    const delays: number[] = [];
    const origSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return origSetTimeout(fn, ms);
    }) as typeof setTimeout);
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        id: 'chatcmpl-cf', object: 'chat.completion', created: 1,
        model: '@cf/zai-org/glm-4.7-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      headers: new Headers(),
    } as unknown as Response);

    await provider.chatCompletion(
      'acct:token',
      [{ role: 'user', content: 'hi' }],
      '@cf/zai-org/glm-4.7-flash',
    );

    expect(delays).toContain(200_000);
    expect(delays).not.toContain(15_000);
  });

  it('nvidia streams use the longer stall watchdog by default', async () => {
    const provider = resolveProvider('nvidia');
    expect(provider).toBeDefined();
    const delays: number[] = [];
    const origSetTimeout = global.setTimeout;
    vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return origSetTimeout(fn, ms);
    }) as typeof setTimeout);
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"deepseek-ai/deepseek-v4-pro","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"deepseek-ai/deepseek-v4-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]));

    const chunks = await collect(provider!.streamChatCompletion(
      'nv-key',
      [{ role: 'user', content: 'hi' }],
      'deepseek-ai/deepseek-v4-pro',
      { timeoutMs: 777 },
    ));

    expect(chunks.length).toBeGreaterThan(0);
    expect(delays).toContain(777);
    expect(delays).toContain(180_000);
    expect(delays).not.toContain(90_000);
  });
});
