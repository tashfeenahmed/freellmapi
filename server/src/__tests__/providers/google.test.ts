import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GoogleProvider();
  });

  it('should have correct platform and name', () => {
    expect(provider.platform).toBe('google');
    expect(provider.name).toBe('Google AI Studio');
  });

  it('should call Gemini API and return OpenAI-compatible response', async () => {
    const mockResponse = {
      candidates: [{
        content: { parts: [{ text: 'Hello from Gemini!' }] },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    };

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as any);

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    );

    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Hello from Gemini!');
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result._routed_via?.platform).toBe('google');
  });

  it('converts an image_url data URL into a Gemini inlineData part (#118)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'a cat' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    } as any);

    await provider.chatCompletion('test-key', [
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ] as any },
    ], 'gemini-2.5-flash');

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body);
    const parts = body.contents[0].parts;
    expect(parts).toContainEqual({ text: 'what is this?' });
    expect(parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
  });

  it('should throw on API error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: () => Promise.resolve({ error: { message: 'Rate limit exceeded' } }),
    } as any);

    await expect(
      provider.chatCompletion('test-key', [{ role: 'user', content: 'Hi' }], 'gemini-2.5-pro')
    ).rejects.toThrow(/Rate limit exceeded/);
  });

  it('should validate key via models endpoint', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: true } as any);
    expect(await provider.validateKey('valid-key')).toBe(true);

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 401 } as any);
    expect(await provider.validateKey('invalid-key')).toBe(false);
  });

  // #268: Google reports a bad key as HTTP 400 INVALID_ARGUMENT / API_KEY_INVALID,
  // not 401/403. A confirmed-bad key must return false (→ auto-disable counter).
  it('validateKey returns false for a genuinely invalid key (HTTP 400 API_KEY_INVALID)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
        },
      }),
    } as any);
    expect(await provider.validateKey('bad-key')).toBe(false);
  });

  // #268: a permission/region/restriction 403 (e.g. API not enabled on the project,
  // or an IP/API-key restriction on the proxy host) must NOT auto-disable a key that
  // may still work for generateContent elsewhere — validateKey throws so health.ts
  // records status='error' instead of incrementing the disable counter.
  it('validateKey throws (does not return false) on a permission/region 403', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({
        error: {
          code: 403,
          message: 'Generative Language API has not been used in project before or it is disabled.',
          status: 'PERMISSION_DENIED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }],
        },
      }),
    } as any);
    await expect(provider.validateKey('region-blocked-key')).rejects.toThrow(/inconclusive/i);
  });

  it('should translate system messages to systemInstruction', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hi' },
      ],
      'gemini-2.5-pro',
    );

    expect(capturedBody.systemInstruction).toEqual({ parts: [{ text: 'You are helpful' }] });
    expect(capturedBody.contents).toHaveLength(1);
    expect(capturedBody.contents[0].role).toBe('user');
  });

  it('should translate OpenAI tools/tool_choice to Gemini tools/toolConfig', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather in Karachi?' }],
      'gemini-2.5-pro',
      {
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        }],
        tool_choice: {
          type: 'function',
          function: { name: 'get_weather' },
        },
      },
    );

    expect(capturedBody.tools[0].functionDeclarations[0].name).toBe('get_weather');
    expect(capturedBody.toolConfig.functionCallingConfig.mode).toBe('ANY');
    expect(capturedBody.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['get_weather']);
  });

  it('maps a google_search tool to Gemini grounding, not a function declaration (#59)', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'grounded answer' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Who won the match today?' }],
      'gemini-2.5-flash',
      { tools: [{ type: 'function', function: { name: 'google_search', description: '', parameters: {} } }] },
    );

    expect(capturedBody.tools).toEqual([{ google_search: {} }]);
    // Grounding-only requests must not carry a functionCallingConfig.
    expect(capturedBody.toolConfig).toBeUndefined();
  });

  it('combines google_search grounding with real function tools (#59)', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather plus latest news?' }],
      'gemini-2.5-pro',
      {
        tools: [
          { type: 'function', function: { name: 'google_search', description: '', parameters: {} } },
          { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
        ],
      },
    );

    expect(capturedBody.tools).toContainEqual({ google_search: {} });
    const decls = capturedBody.tools.find((t: any) => t.functionDeclarations);
    expect(decls.functionDeclarations[0].name).toBe('get_weather');
  });

  it('should translate Gemini functionCall response to OpenAI tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: {
            parts: [{
              functionCall: {
                id: 'call_123',
                name: 'get_weather',
                args: { city: 'Lahore' },
              },
            }],
          },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 3,
          totalTokenCount: 15,
        },
      }),
    } as any);

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'What is the weather?' }],
      'gemini-2.5-pro',
    );

    expect(result.choices[0].finish_reason).toBe('tool_calls');
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls?.[0].id).toBe('call_123');
    expect(result.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
    expect(result.choices[0].message.tool_calls?.[0].function.arguments).toBe('{"city":"Lahore"}');
  });

  it('should preserve and pass through thought_signature', async () => {
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{
                thoughtSignature: 'sig_123',
                functionCall: {
                  id: 'call_123',
                  name: 'get_weather',
                  args: { city: 'London' },
                },
              }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    // 1. Check extraction
    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather?' }],
      'gemini-2.5-pro',
    );

    expect(result.choices[0].message.tool_calls?.[0].thought_signature).toBe('sig_123');

    // 2. Check injection in next turn
    await provider.chatCompletion(
      'test-key',
      [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"London"}' },
            thought_signature: 'sig_123',
          }],
        },
        { role: 'tool', tool_call_id: 'call_123', content: '{"temp": 20}' },
      ],
      'gemini-2.5-pro',
    );

    const assistantEntry = capturedBody.contents.find((c: any) => c.role === 'model');
    expect(assistantEntry.parts[0].thoughtSignature).toBe('sig_123');
    expect(assistantEntry.parts[0].functionCall.name).toBe('get_weather');
  });

  // ── Streaming ──────────────────────────────────────────────────────────────
  // Build a Response-shaped object backed by a ReadableStream so the provider's
  // `res.body.getReader()` path executes for real (Node 20+ has both globally).
  function sseResponse(frames: string[]): any {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    return { ok: true, body: stream };
  }

  async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const c of gen) out.push(c);
    return out;
  }

  it('streams text deltas and emits a final stop chunk', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    ));

    const text = chunks.map(c => c.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('skips a malformed SSE frame instead of aborting the whole stream', async () => {
    // Regression: previously an unguarded JSON.parse would propagate, killing
    // the stream after a single bad chunk. Other providers (openai-compat,
    // cohere, cloudflare) already protect this path with try/catch.
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {oops not json\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    ));

    const text = chunks.map(c => c.choices[0].delta.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('streams functionCall parts as tool_calls with finish_reason=tool_calls', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"get_weather","args":{"city":"Karachi"}}}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather?' }],
      'gemini-2.5-pro',
    ));

    const toolDeltas = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []);
    expect(toolDeltas).toHaveLength(1);
    expect(toolDeltas[0].function.name).toBe('get_weather');
    expect(toolDeltas[0].function.arguments).toBe('{"city":"Karachi"}');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
  });
});
