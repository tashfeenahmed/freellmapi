import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveProvider } from '../../providers/index.js';
import { CloudflareProvider } from '../../providers/cloudflare.js';

// Regression guard for the 2026-07-11 live-sweep finding: platforms hosting
// hidden-reasoning models (zhipu glm-4.7-flash 41s TTFB, agnes-2.0-flash 20s,
// @cf/zai-org/glm-4.7-flash repeated 15s aborts) need a chat timeout above
// the 15s fetch default or every attempt — streaming included — is aborted
// before the first byte. The value is a private construction detail, so the
// registry entries are asserted via the stored field and Cloudflare via the
// setTimeout the abort rides on.

describe('reasoning-model chat timeouts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['zhipu', 60_000],
    ['agnes', 60_000],
    ['ollama', 120_000], // pre-existing bump; keep it from regressing too
  ] as const)('%s is registered with a %dms chat timeout', (platform, ms) => {
    const provider = resolveProvider(platform);
    expect(provider).toBeDefined();
    expect((provider as unknown as { timeoutMs: number }).timeoutMs).toBe(ms);
  });

  it('cloudflare chat aborts on a 60s timer, not the 15s default', async () => {
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

    expect(delays).toContain(60_000);
    expect(delays).not.toContain(15_000);
  });
});
