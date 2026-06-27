import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

describe('OpenAICompatProvider', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'groq',
      name: 'TestProvider',
      baseUrl: 'https://api.test.com/v1',
      extraHeaders: { 'X-Custom': 'test' },
    });
  });

  it('should set platform and name from config', () => {
    expect(provider.platform).toBe('groq');
    expect(provider.name).toBe('TestProvider');
  });

  it('should call API with correct URL and headers', async () => {
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
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion('my-key', [{ role: 'user', content: 'test' }], 'test-model');

    expect(capturedUrl).toBe('https://api.test.com/v1/chat/completions');
    expect(capturedHeaders['Authorization']).toBe('Bearer my-key');
    expect(capturedHeaders['X-Custom']).toBe('test');
    expect(capturedBody.messages[0].role).toBe('user');
  });

  it('should pass tool-calling params through untouched', async () => {
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          id: 'test-id',
          object: 'chat.completion',
          created: 123,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'my-key',
      [{ role: 'user', content: 'what is weather?' }],
      'test-model',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: 'required',
        parallel_tool_calls: true,
      },
    );

    expect(capturedBody.tools).toHaveLength(1);
    expect(capturedBody.tool_choice).toBe('required');
    expect(capturedBody.parallel_tool_calls).toBe(true);
  });

  describe('forceSingleToolCall (NVIDIA NIM single-tool-call 400 — issue #255)', () => {
    const nim = () => new OpenAICompatProvider({
      platform: 'nvidia',
      name: 'NVIDIA NIM',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      forceSingleToolCall: true,
    });
    const okResponse = {
      ok: true,
      json: () => Promise.resolve({
        id: 'x', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any;
    const tools = [{ type: 'function' as const, function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }];

    it('pins parallel_tool_calls to false when tools are present, even if the caller asked for true', async () => {
      let body: any = null;
      vi.spyOn(global, 'fetch').mockImplementation(async (_u, init) => { body = JSON.parse((init as any).body); return okResponse; });
      await nim().chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm', { tools, parallel_tool_calls: true });
      expect(body.parallel_tool_calls).toBe(false);
    });

    it('leaves parallel_tool_calls untouched when there are no tools', async () => {
      let body: any = null;
      vi.spyOn(global, 'fetch').mockImplementation(async (_u, init) => { body = JSON.parse((init as any).body); return okResponse; });
      await nim().chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm', {});
      expect(body.parallel_tool_calls).toBeUndefined();
    });

    it('does not affect providers without the flag (parallel_tool_calls passes through)', async () => {
      let body: any = null;
      vi.spyOn(global, 'fetch').mockImplementation(async (_u, init) => { body = JSON.parse((init as any).body); return okResponse; });
      await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm', { tools, parallel_tool_calls: true });
      expect(body.parallel_tool_calls).toBe(true);
    });
  });

  it('should throw on error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Rate Limited',
      json: () => Promise.resolve({ error: { message: 'Too many requests' } }),
    } as any);

    await expect(
      provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')
    ).rejects.toThrow(/Too many requests/);
  });

  it('explains a non-JSON 200 body instead of surfacing the raw parse error (#189)', async () => {
    // e.g. a custom base URL pointing at Ollama's native NDJSON /api endpoint:
    // real fetch's res.json() rejects with "Unexpected non-whitespace character
    // after JSON at position …", which is useless to the user.
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected non-whitespace character after JSON at position 583 (line 27 column 2)')),
    } as any);

    await expect(
      provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model')
    ).rejects.toThrow(/not OpenAI-compatible/);
  });

  it('should validate key using models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true, status: 200 } as any);
    expect(await provider.validateKey('valid')).toBe(true);
  });

  it('validateKey returns false on confirmed 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('bad')).toBe(false);
  });

  it('validateKey propagates transport errors instead of swallowing', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(provider.validateKey('any')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('folds reasoning_content into content when content is empty (Z.ai glm-4.5-flash style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'the actual answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('the actual answer');
  });

  it('flattens array content into a string (Mistral magistral style)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('part one part two');
  });

  it('folds reasoning into content when content is empty (Ollama style — bare `reasoning` field)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning: 'ollama answer' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('ollama answer');
  });

  it('prefers reasoning_content over reasoning when both are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: 'preferred', reasoning: 'fallback' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('preferred');
  });

  it('does NOT fold reasoning_content when tool_calls are present', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            reasoning_content: 'I am thinking about the tool',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('leaves real string content untouched', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'id', object: 'chat.completion', created: 1, model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'normal answer', reasoning_content: 'should not override' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('normal answer');
  });
});

describe('OpenAICompatProvider - platform instances', () => {
  // Mirrors the actual registrations in server/src/providers/index.ts.
  // Update both when adding/removing a platform.
  const platforms = [
    { platform: 'groq',       name: 'Groq',          baseUrl: 'https://api.groq.com/openai/v1' },
    { platform: 'cerebras',   name: 'Cerebras',      baseUrl: 'https://api.cerebras.ai/v1' },
    { platform: 'nvidia',     name: 'NVIDIA NIM',    baseUrl: 'https://integrate.api.nvidia.com/v1' },
    { platform: 'mistral',    name: 'Mistral',       baseUrl: 'https://api.mistral.ai/v1' },
    { platform: 'openrouter', name: 'OpenRouter',    baseUrl: 'https://openrouter.ai/api/v1' },
    { platform: 'github',     name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference' },
    { platform: 'zhipu',      name: 'Zhipu AI',      baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { platform: 'opencode',   name: 'OpenCode Zen',  baseUrl: 'https://opencode.ai/zen/v1' },
  ] as const;

  for (const p of platforms) {
    it(`${p.name} provider should make requests to ${p.baseUrl}`, async () => {
      const provider = new OpenAICompatProvider(p as any);

      let capturedUrl = '';
      vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
        capturedUrl = url as string;
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'id', object: 'chat.completion', created: 1, model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        } as any;
      });

      const result = await provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'model');
      expect(capturedUrl).toContain(p.baseUrl);
      expect(result._routed_via?.platform).toBe(p.platform);
    });
  }

  // #264: Groq (and others) reject a model's inline tool-call dialect with a 400
  // `tool_use_failed`, handing back the raw text in `error.failed_generation`.
  // We rescue it into structured tool_calls instead of dead-ending the turn.
  describe('tool_use_failed rescue (#264)', () => {
    let provider: OpenAICompatProvider;
    beforeEach(() => {
      provider = new OpenAICompatProvider({ platform: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' });
    });
    const tools = [{
      type: 'function' as const,
      function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    }];
    const failBody = {
      error: {
        message: 'Failed to call a function. Please adjust your prompt. See \'failed_generation\' for more details.',
        type: 'invalid_request_error',
        code: 'tool_use_failed',
        failed_generation: '<function=read={"file_path": "sample.txt"}</function>',
      },
    };

    it('non-stream: rescues failed_generation into structured tool_calls', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false, status: 400, statusText: 'Bad Request',
        json: () => Promise.resolve(failBody),
      } as any);

      const r = await provider.chatCompletion('key', [{ role: 'user', content: 'read sample.txt' }], 'llama-3.3-70b-versatile', { tools, tool_choice: 'auto' });
      expect(r.choices[0].finish_reason).toBe('tool_calls');
      const tc = r.choices[0].message.tool_calls;
      expect(tc?.length).toBe(1);
      expect(tc![0].function.name).toBe('read');
      expect(JSON.parse(tc![0].function.arguments)).toEqual({ file_path: 'sample.txt' });
    });

    it('stream: yields a synthesized tool_calls turn instead of throwing', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false, status: 400, statusText: 'Bad Request',
        json: () => Promise.resolve(failBody),
      } as any);

      const chunks: any[] = [];
      for await (const c of provider.streamChatCompletion('key', [{ role: 'user', content: 'read sample.txt' }], 'llama-3.3-70b-versatile', { tools, tool_choice: 'auto' })) {
        chunks.push(c);
      }
      const calls = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []);
      expect(calls.length).toBe(1);
      expect(calls[0].function.name).toBe('read');
      expect(chunks.some(c => c.choices[0].finish_reason === 'tool_calls')).toBe(true);
    });

    it('still throws when there is no failed_generation to rescue', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false, status: 400, statusText: 'Bad Request',
        json: () => Promise.resolve({ error: { message: 'bad request', code: 'invalid_request' } }),
      } as any);
      await expect(
        provider.chatCompletion('key', [{ role: 'user', content: 'hi' }], 'm', { tools }),
      ).rejects.toThrow(/API error 400/);
    });
  });
});
