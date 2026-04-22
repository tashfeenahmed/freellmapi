import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

describe('GoogleProvider', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
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
});
