import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { mockRunFusion } = vi.hoisted(() => ({ mockRunFusion: vi.fn() }));

// Keep the real schema/error helpers, but isolate this route test from the
// catalog and upstream provider implementations. The assertions below verify
// that the Responses surface accepts the virtual id and faithfully translates
// the existing Fusion result in both wire modes.
vi.mock('../../services/fusion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/fusion.js')>();
  return { ...actual, runFusion: mockRunFusion };
});

import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';

async function post(app: Express, body: unknown, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  server.close();
  return { status: response.status, text, headers: response.headers };
}

function fusionResult(text = 'fused answer') {
  return {
    response: {
      id: 'chat-fusion',
      object: 'chat.completion' as const,
      created: 1,
      model: 'fusion',
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: text },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      _fusion: {
        panel: [{ platform: 'google', model: 'gemini-3.5-flash-lite' }],
        judge: null,
        synthesized: false,
      },
      x_fusion: { strategy: 'best_of', synthesized: false },
    },
    routedVia: 'fusion(google/gemini-3.5-flash-lite)',
  };
}

describe('POST /v1/responses virtual Fusion model', () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => mockRunFusion.mockReset());

  it('dispatches model=fusion without a catalog row and translates the result', async () => {
    mockRunFusion.mockResolvedValue(fusionResult());

    const { status, text, headers } = await post(app, {
      model: 'fusion',
      input: 'compare these answers',
      fusion: { strategy: 'best_of', k: 2, expose_panel: true },
    }, key);

    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body.object).toBe('response');
    expect(body.model).toBe('fusion');
    expect(body.output_text).toBe('fused answer');
    expect(body.output[0]).toMatchObject({ type: 'message', role: 'assistant' });
    expect(body.usage).toMatchObject({ input_tokens: 5, output_tokens: 7, total_tokens: 12 });
    expect(body._fusion).toMatchObject({ synthesized: false });
    expect(body.x_fusion).toMatchObject({ strategy: 'best_of' });
    expect(headers.get('x-routed-via')).toBe('fusion(google/gemini-3.5-flash-lite)');

    expect(mockRunFusion).toHaveBeenCalledTimes(1);
    expect(mockRunFusion.mock.calls[0][0]).toMatchObject({
      messages: [{ role: 'user', content: 'compare these answers' }],
      config: { strategy: 'best_of', k: 2, expose_panel: true },
      vision: false,
    });
  });

  it('emits a Responses SSE sequence for a streamed Fusion judge', async () => {
    mockRunFusion.mockImplementation(async (params: any) => {
      params?.hooks?.onJudgeDelta?.('fused ');
      params?.hooks?.onJudgeDelta?.('stream');
      return fusionResult('fused stream');
    });

    const { status, text, headers } = await post(app, {
      model: 'fusion',
      input: 'stream the synthesis',
      stream: true,
    }, key);

    expect(status).toBe(200);
    expect(headers.get('content-type')).toContain('text/event-stream');
    for (const event of [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]) {
      expect(text).toContain(`event: ${event}`);
    }
    expect(text).toContain('"delta":"fused "');
    expect(text).toContain('"delta":"stream"');
    const completed = text.split('event: response.completed')[1];
    expect(completed).toContain('"output_text":"fused stream"');
    expect(mockRunFusion).toHaveBeenCalledTimes(1);
    expect(mockRunFusion.mock.calls[0]?.[0]?.hooks).toBeDefined();
  });
});
