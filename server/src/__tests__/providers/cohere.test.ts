import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CohereProvider } from '../../providers/cohere.js';

describe('CohereProvider', () => {
  let provider: CohereProvider;

  beforeEach(() => {
    provider = new CohereProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('cohere');
    expect(provider.name).toBe('Cohere');
  });

  it('should call compatibility API and return OpenAI response', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'cohere-123',
          object: 'chat.completion',
          created: 123,
          model: 'command-a-03-2025',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from Cohere!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      } as any;
    });

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'command-r-plus-08-2024',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
            },
          },
        }],
      },
    );

    expect(capturedUrl).toContain('/compatibility/v1/chat/completions');
    expect(capturedBody.tools).toHaveLength(1);
    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Hello from Cohere!');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result._routed_via?.platform).toBe('cohere');
  });

  it('strips additionalProperties / $schema from tool parameters before sending', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'c', object: 'chat.completion', created: 1, model: 'command-a',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion('k', [{ role: 'user', content: 'Hi' }], 'command-a-03-2025', {
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            properties: {
              city: { type: 'string' },
              opts: { type: 'object', additionalProperties: false, properties: {} },
            },
          },
        },
      }],
    });

    const params = capturedBody.tools[0].function.parameters;
    expect(params.additionalProperties).toBeUndefined();
    expect(params.$schema).toBeUndefined();
    expect(params.properties.opts.additionalProperties).toBeUndefined();
    // Real schema content is preserved.
    expect(params.type).toBe('object');
    expect(params.properties.city).toEqual({ type: 'string' });
  });

  it('passes through requests with no tools unchanged', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementationOnce(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'c', object: 'chat.completion', created: 1, model: 'command-a',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion('k', [{ role: 'user', content: 'Hi' }], 'command-a-03-2025');
    expect(capturedBody.tools).toBeUndefined();
  });

  it('should validate key', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true } as any);
    expect(await provider.validateKey('valid')).toBe(true);
  });
});
