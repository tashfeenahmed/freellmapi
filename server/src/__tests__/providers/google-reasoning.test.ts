import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleProvider } from '../../providers/google.js';

describe('GoogleProvider reasoning_effort', () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    provider = new GoogleProvider();
  });

  function mockGenerateContent() {
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
    return () => capturedBody;
  }

  async function completeWithEffort(modelId: string, reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high') {
    const getBody = mockGenerateContent();
    await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Think about it' }],
      modelId,
      reasoning_effort ? { reasoning_effort } : undefined,
    );
    vi.restoreAllMocks();
    return getBody();
  }

  it('maps minimal effort to budget 512, with Pro using 128', async () => {
    const flashBody = await completeWithEffort('gemini-2.5-flash', 'minimal');
    expect(flashBody.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 512,
      includeThoughts: true,
    });

    const proBody = await completeWithEffort('gemini-2.5-pro', 'minimal');
    expect(proBody.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 128,
      includeThoughts: true,
    });
  });

  it('maps low, medium, and high efforts to Gemini thinking budgets', async () => {
    const lowBody = await completeWithEffort('gemini-2.5-flash', 'low');
    expect(lowBody.generationConfig.thinkingConfig.thinkingBudget).toBe(1024);

    const mediumBody = await completeWithEffort('gemini-2.5-flash', 'medium');
    expect(mediumBody.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);

    const highBody = await completeWithEffort('gemini-2.5-flash', 'high');
    expect(highBody.generationConfig.thinkingConfig.thinkingBudget).toBe(24576);
  });

  it('uses thinkingLevel instead of thinkingBudget for gemini-3 models', async () => {
    const body = await completeWithEffort('gemini-3.0-flash', 'medium');
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'MEDIUM',
      includeThoughts: true,
    });
    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
  });

  it('falls back from MINIMAL to LOW for gemini-3.1-pro', async () => {
    const body = await completeWithEffort('gemini-3.1-pro', 'minimal');
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'LOW',
      includeThoughts: true,
    });
  });

  it('sets includeThoughts only when reasoning_effort is provided', async () => {
    const body = await completeWithEffort('gemini-2.5-flash');
    expect(body.generationConfig.thinkingConfig).toBeUndefined();

    const reasoningBody = await completeWithEffort('gemini-2.5-flash', 'low');
    expect(reasoningBody.generationConfig.thinkingConfig.includeThoughts).toBe(true);
  });

  it('maps thought parts to message.reasoning_content and thoughtsTokenCount to reasoning_tokens', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: { parts: [{ text: 'I should reason. ', thought: true }, { text: 'Final answer.' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 3,
          totalTokenCount: 18,
        },
      }),
    } as any);

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
      { reasoning_effort: 'low' },
    );
    vi.restoreAllMocks();

    expect(result.choices[0].message.content).toBe('Final answer.');
    expect(result.choices[0].message.reasoning_content).toBe('I should reason. ');
    expect(result.usage.completion_tokens_details?.reasoning_tokens).toBe(3);
  });

  it('omits message.reasoning_content when the response has no thought parts', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'Final answer.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    } as any);

    const result = await provider.chatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
    );
    vi.restoreAllMocks();

    expect(result.choices[0].message.content).toBe('Final answer.');
    expect(result.choices[0].message.reasoning_content).toBeUndefined();
  });

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

  it('streams thought parts as delta.reasoning_content', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"Think ","thought":true}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"final"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n',
    ]));

    const chunks = await collect(provider.streamChatCompletion(
      'test-key',
      [{ role: 'user', content: 'Hi' }],
      'gemini-2.5-pro',
      { reasoning_effort: 'low' },
    ));
    vi.restoreAllMocks();

    const reasoning = chunks.map(c => c.choices[0].delta.reasoning_content ?? '').join('');
    const content = chunks.map(c => c.choices[0].delta.content ?? '').join('');
    expect(reasoning).toBe('Think ');
    expect(content).toBe('final');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });
});
