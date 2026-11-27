import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { runFallbackLoop, newFallbackState } from '../../lib/fallback-loop.js';
import { newHedgeAbortError } from '../../lib/error-classify.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { acquireLease, releaseLease, resetLeases } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

/**
 * #1960 end to end through the real SSE reader: a loopback upstream, a real
 * OpenAICompatProvider and the shared fallback loop, wired the way the
 * streaming surfaces wire them (per-attempt hedge controller, abortInFlight
 * replacing it). The cap must fail over a stream that opens and then sends
 * nothing, and must leave every stream that sends ANY bytes alone: SSE
 * keep-alive comments, role-only first chunks and reasoning deltas included.
 */

const CAP_MS = 150;
const SLOW_MS = 450; // silence after the first activity: three times the cap

function frame(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
const CONTENT = frame({ content: 'hello' });
const FINISH = frame({}, 'stop') + 'data: [DONE]\n\n';

// The upstream's behavior is picked by the requested model id.
type Step = { afterMs: number; data: string };
const SCENARIOS: Record<string, Step[] | 'stall'> = {
  stall: 'stall',
  normal: [{ afterMs: 0, data: CONTENT }, { afterMs: 5, data: FINISH }],
  keepalive: [{ afterMs: 20, data: ': keep-alive\n\n' }, { afterMs: SLOW_MS, data: CONTENT }, { afterMs: 5, data: FINISH }],
  role: [{ afterMs: 20, data: frame({ role: 'assistant', content: '' }) }, { afterMs: SLOW_MS, data: CONTENT }, { afterMs: 5, data: FINISH }],
  reasoning: [{ afterMs: 50, data: frame({ reasoning_content: 'thinking' }) }, { afterMs: SLOW_MS, data: CONTENT }, { afterMs: 5, data: FINISH }],
  gap: [{ afterMs: 0, data: CONTENT }, { afterMs: SLOW_MS, data: CONTENT }, { afterMs: 5, data: FINISH }],
  // Silent past the cap before the first byte; only legal on a platform that
  // declared a slow first byte.
  slowfirst: [{ afterMs: SLOW_MS, data: CONTENT }, { afterMs: 5, data: FINISH }],
};

let server: http.Server;
let baseUrl = '';
const requested: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const model = String(JSON.parse(body || '{}').model ?? '');
      requested.push(model);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      const scenario = SCENARIOS[model];
      if (scenario === 'stall' || !scenario) return; // headers only, then silence
      let at = 0;
      for (const step of scenario) {
        at += step.afterMs;
        setTimeout(() => { if (!res.writableEnded) res.write(step.data); }, at);
      }
      setTimeout(() => { if (!res.writableEnded) res.end(); }, at + 10);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  initDb(':memory:');
  resetLeases();
  requested.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetLeases();
  vi.restoreAllMocks();
});

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const standard = () => new OpenAICompatProvider({ platform: 'groq', name: 'Standard', baseUrl, timeoutMs: 60_000 });
const declaredSlow = () => new OpenAICompatProvider({ platform: 'nvidia', name: 'Slow', baseUrl, timeoutMs: 180_000 });

let keySeq = 7000;
function route(provider: OpenAICompatProvider, modelId: string): RouteResult {
  const keyId = ++keySeq;
  const lease = acquireLease(provider.platform, modelId, keyId, 100);
  return {
    provider, modelId, modelDbId: 700000 + keyId, apiKey: 'k', keyId,
    keyLabel: null, platform: provider.platform, displayName: modelId, contextWindow: null, endpointScope: '',
    rpdLimit: null, tpdLimit: null, release: () => releaseLease(lease),
  };
}

/** Run one streaming request over `ladder` the way the surfaces do. */
async function serve(ladder: RouteResult[], opts: { streaming?: boolean } = {}) {
  const state = newFallbackState();
  let hedgeAbort = new AbortController();
  const abortInFlight = vi.fn(() => { hedgeAbort.abort(newHedgeAbortError()); hedgeAbort = new AbortController(); });
  const served: { modelId: string; text: string }[] = [];
  const logFailure = vi.fn();
  const onExhausted = vi.fn();
  let i = 0;
  await runFallbackLoop({
    state,
    maxRetries: ladder.length,
    timeBudgetMs: 10_000,
    streaming: opts.streaming ?? true,
    attemptSilentMs: CAP_MS,
    abortInFlight,
    logFailure,
    onFatal: vi.fn(),
    onRoutingExhausted: vi.fn(),
    onExhausted,
    route: () => {
      if (i >= ladder.length) throw new Error('no more routes');
      return ladder[i++];
    },
    dispatch: async (r: RouteResult) => {
      let text = '';
      for await (const chunk of r.provider.streamChatCompletion(r.apiKey, MESSAGES, r.modelId, { signal: hedgeAbort.signal })) {
        text += chunk.choices?.[0]?.delta?.content ?? '';
      }
      served.push({ modelId: r.modelId, text });
      return 'done';
    },
  } as any);
  return { served, abortInFlight, logFailure, onExhausted };
}

describe('silent-window cap through the real SSE reader (#1960)', () => {
  it('(a) an upstream that opens and then stalls forever fails over within the cap', async () => {
    const t0 = Date.now();
    const out = await serve([route(standard(), 'stall'), route(standard(), 'normal')]);
    expect(out.served).toEqual([{ modelId: 'normal', text: 'hello' }]);
    expect(out.abortInFlight).toHaveBeenCalledTimes(1);
    expect(out.logFailure).toHaveBeenCalledTimes(1);
    expect(out.logFailure.mock.calls[0][1].message).toMatch(/attempt silent-window timeout/);
    expect(out.onExhausted).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it.each([
    ['an SSE keep-alive comment', 'keepalive'],
    ['a role-only first chunk', 'role'],
    ['a reasoning delta', 'reasoning'],
  ])('(b) %s counts as activity: a slow first content token is still served', async (_label, model) => {
    const out = await serve([route(standard(), model), route(standard(), 'normal')]);
    expect(out.served).toEqual([{ modelId: model, text: 'hello' }]);
    expect(out.abortInFlight).not.toHaveBeenCalled();
    expect(out.logFailure).not.toHaveBeenCalled();
  });

  it('(c) a normal stream is served untouched', async () => {
    const out = await serve([route(standard(), 'normal')]);
    expect(out.served).toEqual([{ modelId: 'normal', text: 'hello' }]);
    expect(out.abortInFlight).not.toHaveBeenCalled();
  });

  it('never applies between tokens: a long gap after the first token is left alone', async () => {
    const out = await serve([route(standard(), 'gap'), route(standard(), 'normal')]);
    expect(out.served).toEqual([{ modelId: 'gap', text: 'hellohello' }]);
    expect(out.abortInFlight).not.toHaveBeenCalled();
  });

  it('a platform that declared a slow first byte is exempt and keeps its own watchdog', async () => {
    const out = await serve([route(declaredSlow(), 'slowfirst'), route(standard(), 'normal')]);
    expect(out.served).toEqual([{ modelId: 'slowfirst', text: 'hello' }]);
    expect(out.abortInFlight).not.toHaveBeenCalled();
  });

  it('the same silent first byte on a standard platform IS capped (control for the exemption)', async () => {
    const out = await serve([route(standard(), 'slowfirst'), route(standard(), 'normal')]);
    expect(out.served).toEqual([{ modelId: 'normal', text: 'hello' }]);
    expect(out.abortInFlight).toHaveBeenCalledTimes(1);
  });

  it('non-streaming requests are never capped, even when the adapter reads SSE', async () => {
    const out = await serve([route(standard(), 'slowfirst'), route(standard(), 'normal')], { streaming: false });
    expect(out.served).toEqual([{ modelId: 'slowfirst', text: 'hello' }]);
    expect(out.abortInFlight).not.toHaveBeenCalled();
  });
});
