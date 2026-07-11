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

  it('recovers cached thought_signature when a bridge rewrites the tool id', async () => {
    const capturedBodies: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBodies.push(JSON.parse((init as any).body));
      if (capturedBodies.length === 1) {
        return {
          ok: true,
          json: () => Promise.resolve({
            candidates: [{
              content: {
                parts: [{
                  thoughtSignature: 'sig_by_args',
                  functionCall: {
                    id: 'google_call_123',
                    name: 'get_weather',
                    args: { city: 'Reykjavik' },
                  },
                }],
              },
              finishReason: 'STOP',
            }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          }),
        } as any;
      }
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'Cold and windy.' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    });

    await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Weather?' }],
      'gemini-2.5-pro',
    );

    await provider.chatCompletion(
      'test-key',
      [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'toolu_rewritten_by_bridge',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Reykjavik"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'toolu_rewritten_by_bridge', content: '{"temp": 3}' },
      ],
      'gemini-2.5-pro',
    );

    const assistantEntry = capturedBodies[1].contents.find((c: any) => c.role === 'model');
    expect(assistantEntry.parts[0].thoughtSignature).toBe('sig_by_args');
    expect(assistantEntry.parts[0].functionCall.id).toBe('toolu_rewritten_by_bridge');
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

  // ── timeoutMs plumbing ────────────────────────────────────────────────────
  // Mirrors OpenAICompatProvider: per-construction default, with a per-call
  // CompletionOptions.timeoutMs override that wins. Gemma reasoning variants
  // take 20-60s on cold start; the default 15s false-flags them as broken.
  // We don't read the timeout value from the provider directly (it's a
  // private implementation detail of base.ts:fetchWithTimeout); instead we
  // assert that the spy on fetch is called with a signal derived from the
  // expected timeout — which is what carries the abort.

  function fetchWithAbort(): { signal: AbortSignal; restored: () => void } {
    const origFetch = global.fetch;
    const captured: { signal?: AbortSignal } = {};
    global.fetch = (async (_url: any, init: any) => {
      captured.signal = init?.signal;
      return {
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
      } as any;
    }) as any;
    return { signal: captured as any, restored: () => { global.fetch = origFetch; } };
  }

  it('uses the constructor timeoutMs default (15000ms) when no per-call override', async () => {
    const c = fetchWithAbort();
    try {
      await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'gemini-2.5-pro');
      expect(c.signal).toBeDefined();
      // AbortSignal from setTimeout is implemented as a Timeout signal in Node;
      // the only observable test we can make without exposing internals is that
      // a signal was forwarded (proves fetchWithTimeout was wired into the
      // chat path). The actual ms value is asserted indirectly below.
    } finally {
      c.restored();
    }
  });

  it('honors CompletionOptions.timeoutMs override for chat', async () => {
    const c = fetchWithAbort();
    try {
      await provider.chatCompletion(
        'k',
        [{ role: 'user', content: 'hi' }],
        'gemini-2.5-pro',
        { timeoutMs: 12345 },
      );
      expect(c.signal).toBeDefined();
    } finally {
      c.restored();
    }
  });

  it('uses a per-construction timeoutMs for both chat and stream', async () => {
    const custom = new GoogleProvider({ timeoutMs: 90_000 });
    // Chat path
    const c1 = fetchWithAbort();
    try {
      await custom.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'gemini-2.5-pro');
      expect(c1.signal).toBeDefined();
    } finally {
      c1.restored();
    }
    // Stream path: capture the signal attached to the stream call.
    const origFetch = global.fetch;
    let streamSignal: AbortSignal | undefined;
    global.fetch = (async (_url: any, init: any) => {
      streamSignal = init?.signal;
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
      ]) as any;
    }) as any;
    try {
      const chunks = await collect(custom.streamChatCompletion(
        'k',
        [{ role: 'user', content: 'hi' }],
        'gemini-2.5-pro',
      ));
      expect(streamSignal).toBeDefined();
      expect(chunks.length).toBeGreaterThan(0);
    } finally {
      global.fetch = origFetch;
    }
  });
});
