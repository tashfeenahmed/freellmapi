import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LlmtrProvider,
  LLMTR_VALIDATION_GAP_ENV,
  LLMTR_VALIDATION_MIN_GAP_MS,
  type LlmtrProviderOptions,
} from '../../providers/llmtr.js';

// #1369: every key-validation probe is the same nonexistent-model POST, and a
// burst of them from one IP is the pattern LLMTR's security system reads as
// automation — an account flagged that way gets suspended. validateKey is the
// only door to the network, so pacing there covers every caller: the 5-minute
// health pass, the forced pass behind the dashboard's "check all" button, the
// post-wake re-probe, the cooldown-probe job and the 401-triggered revalidation.

const modelNotFound = () => new Response(
  JSON.stringify({ error: { type: 'model_not_found', message: 'Model not found' } }),
  { status: 404 },
);

/** Fake clock driven by the injected sleep, so pacing costs no real time. */
function fakeClock() {
  const state = { t: 10_000 };
  return {
    now: () => state.t,
    sleep: async (ms: number) => { state.t += ms; },
    at: () => state.t,
  };
}

/** Provider wired to the fake clock, recording the start time of each probe. */
function pacedProvider(opts: LlmtrProviderOptions = {}) {
  const clock = fakeClock();
  const starts: number[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async () => {
    starts.push(clock.at());
    return modelNotFound();
  });
  const provider = new LlmtrProvider({ now: clock.now, sleep: clock.sleep, ...opts });
  return { provider, clock, starts };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[LLMTR_VALIDATION_GAP_ENV];
});

describe('LLMTR key-validation probe pacing', () => {
  it('leaves the first probe unspaced and spaces the rest by the gap floor', async () => {
    const { provider, clock, starts } = pacedProvider({ validationMinGapMs: 2_000 });

    await Promise.all([
      provider.validateKey('key-a'),
      provider.validateKey('key-b'),
      provider.validateKey('key-c'),
    ]);

    // Nothing probed before this provider existed, so the floor is measured
    // from the epoch-relative 0 rather than stalling the very first probe.
    expect(starts).toEqual([10_000, 12_000, 14_000]);
    expect(clock.at()).toBe(14_000);
  });

  it('spaces by the shipped default when no override is given', async () => {
    const { provider, starts } = pacedProvider();

    await provider.validateKey('key-a');
    await provider.validateKey('key-b');

    expect(starts[1]! - starts[0]!).toBe(LLMTR_VALIDATION_MIN_GAP_MS);
  });

  it('runs probes one at a time, so no two overlap', async () => {
    let live = 0;
    let maxLive = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise(resolve => setTimeout(resolve, 5));
      live--;
      return modelNotFound();
    });
    const clock = fakeClock();
    const provider = new LlmtrProvider({ now: clock.now, sleep: clock.sleep, validationMinGapMs: 0 });

    await Promise.all([
      provider.validateKey('key-a'),
      provider.validateKey('key-b'),
      provider.validateKey('key-c'),
    ]);

    expect(maxLive).toBe(1);
  });

  it('coalesces concurrent probes of the same credential into one request', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(modelNotFound());
    const clock = fakeClock();
    const provider = new LlmtrProvider({ now: clock.now, sleep: clock.sleep });

    const verdicts = await Promise.all([
      provider.validateKey('same-key'),
      provider.validateKey('same-key'),
      provider.validateKey('same-key'),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(verdicts).toEqual([true, true, true]);
  });

  it('does not serve a later probe from a settled one', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(modelNotFound());
    const clock = fakeClock();
    const provider = new LlmtrProvider({ now: clock.now, sleep: clock.sleep, validationMinGapMs: 0 });

    await provider.validateKey('same-key');
    await provider.validateKey('same-key');

    // The map entry is retired on settle: a key can be revoked between checks,
    // and a cached "valid" would keep routing to a dead credential.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shares one request even across a pacing wait', async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() => new Promise<Response>(resolve => {
      resolveFetch = resolve;
    }));
    const clock = fakeClock();
    const provider = new LlmtrProvider({ now: clock.now, sleep: clock.sleep, validationMinGapMs: 5_000 });

    const first = provider.validateKey('same-key');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const second = provider.validateKey('same-key');
    resolveFetch(modelNotFound());

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(clock.at()).toBe(10_000);
  });

  it('keeps the queue moving after a failed probe', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: 'other' } }), { status: 500 }))
      .mockResolvedValue(modelNotFound());
    const clock = fakeClock();
    const provider = new LlmtrProvider({ now: clock.now, sleep: clock.sleep, validationMinGapMs: 1_000 });

    await expect(provider.validateKey('key-a')).rejects.toMatchObject({ status: 500 });

    await expect(provider.validateKey('key-b')).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The rejected probe still consumed its slot, so the next one waited the
    // gap rather than firing immediately behind it.
    expect(clock.at()).toBe(11_000);
  });

  it('retires a rejected probe so a retry is a fresh request', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(modelNotFound());
    const clock = fakeClock();
    const provider = new LlmtrProvider({ now: clock.now, sleep: clock.sleep, validationMinGapMs: 0 });

    await expect(provider.validateKey('key-a')).rejects.toThrow('ECONNRESET');
    await expect(provider.validateKey('key-a')).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not pace when the gap is 0', async () => {
    const { provider, clock, starts } = pacedProvider({ validationMinGapMs: 0 });

    await provider.validateKey('key-a');
    await provider.validateKey('key-b');
    await provider.validateKey('key-c');

    expect(starts).toEqual([10_000, 10_000, 10_000]);
    expect(clock.at()).toBe(10_000);
  });

  it('reads the gap floor from the environment', async () => {
    process.env[LLMTR_VALIDATION_GAP_ENV] = '750';
    const { provider, starts } = pacedProvider();

    await provider.validateKey('key-a');
    await provider.validateKey('key-b');

    expect(starts[1]! - starts[0]!).toBe(750);
  });

  it('falls back to the default for a nonsensical gap and says so once', async () => {
    process.env[LLMTR_VALIDATION_GAP_ENV] = 'soon';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { provider, starts } = pacedProvider();

    await provider.validateKey('key-a');
    await provider.validateKey('key-b');

    expect(starts[1]! - starts[0]!).toBe(LLMTR_VALIDATION_MIN_GAP_MS);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain(LLMTR_VALIDATION_GAP_ENV);
  });

  it('leaves chat traffic unpaced — real requests must not queue behind probes', async () => {
    const clock = fakeClock();
    const bodies: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      // The probe names the validation model; chat names a real route.
      return body.model === '__freellmapi_key_validation__'
        ? modelNotFound()
        : new Response(JSON.stringify({
          id: 'c', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200 });
    });
    const provider = new LlmtrProvider({ now: clock.now, sleep: clock.sleep, validationMinGapMs: 2_000 });

    await provider.validateKey('key-a');
    const afterProbe = clock.at();
    await provider.chatCompletion('key-a', [{ role: 'user', content: 'OK' }], 'qwen/qwen3.8-27b-free');

    // The chat request went out without waiting out the 2s floor a second probe
    // would have owed: only the probe is paced, never real traffic.
    expect(clock.at()).toBe(afterProbe);
    expect(bodies.map(b => b.model)).toEqual(['__freellmapi_key_validation__', 'qwen/qwen3.8-27b-free']);
  });
});