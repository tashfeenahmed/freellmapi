import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudflareProvider } from '../../providers/cloudflare.js';

describe('CloudflareProvider', () => {
  let provider: CloudflareProvider;

  beforeEach(() => {
    provider = new CloudflareProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('cloudflare');
    expect(provider.name).toBe('Cloudflare Workers AI');
  });

  it('should parse account_id:token key format', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url as string;
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'chatcmpl-cf',
          object: 'chat.completion',
          created: 123,
          model: '@cf/meta/llama-3.1-70b-instruct',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from CF!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'abc123:my-token-here',
      [{ role: 'user', content: 'Hi' }],
      '@cf/meta/llama-3.1-70b-instruct',
    );

    expect(capturedUrl).toContain('abc123');
    expect(capturedUrl).toContain('/ai/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-token-here');
    expect(capturedBody.model).toBe('@cf/meta/llama-3.1-70b-instruct');
    expect(result.choices[0].message.content).toBe('Hello from CF!');
  });

  it('should throw if key format is wrong', async () => {
    await expect(
      provider.chatCompletion('no-colon-here', [{ role: 'user', content: 'Hi' }], 'model')
    ).rejects.toThrow(/account_id:api_token/);
  });
});
