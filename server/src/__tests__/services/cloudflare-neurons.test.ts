import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { CloudflareProvider } from '../../providers/cloudflare.js';
import {
  CloudflareNeuronCapError,
  CloudflareRequestTooLargeError,
  DEFAULT_CLOUDFLARE_DAILY_NEURON_CAP,
  cloudflareNeuronsAvailable,
  cloudflareNeuronsUsedToday,
  localNeuronsToday,
  meterCloudflare,
  neuronsFor,
  refreshRemoteNeurons,
  resetCloudflareNeuronMeter,
  startCloudflareCall,
} from '../../services/cloudflare-neurons.js';
import { isCloudflareNeuronsExhausted } from '../../services/cloudflare-daily-quota.js';
import { reserveProviderCredential } from '../../services/provider-credential.js';
import { clearAllCooldowns, isOnCooldown } from '../../services/ratelimit.js';

// Workers AI's 10K free neurons/day are per account. On Workers Paid Cloudflare
// never 429s once they are gone, it bills, so FreeLLMAPI meters neurons itself
// and stops at the cap. These tests pin the "free neurons stay free" contract.

const KEY_A1 = 'account-a:token-one';
const KEY_A2 = 'ACCOUNT-A:token-two';
const KEY_B = 'account-b:token-three';
const SCOUT = '@cf/meta/llama-4-scout-17b-16e-instruct';
const LLAMA_70B = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);

function insertKey(value: string): number {
  const { encrypted, iv, authTag } = encrypt(value);
  return Number(getDb().prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('cloudflare', 'test', ?, ?, ?, 'healthy', 1)",
  ).run(encrypted, iv, authTag).lastInsertRowid);
}

/** Put real usage on an account's ledger without the cap in the way. */
function spend(key: string, inputTokens: number, outputTokens: number, now = Date.now()): void {
  const cap = process.env.CLOUDFLARE_DAILY_NEURON_CAP;
  process.env.CLOUDFLARE_DAILY_NEURON_CAP = '0';
  try {
    startCloudflareCall(key, SCOUT, { inputTokens, outputTokens }, now).settle({ inputTokens, outputTokens });
  } finally {
    if (cap === undefined) delete process.env.CLOUDFLARE_DAILY_NEURON_CAP;
    else process.env.CLOUDFLARE_DAILY_NEURON_CAP = cap;
  }
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare("DELETE FROM api_keys WHERE platform = 'cloudflare'").run();
  getDb().prepare('DELETE FROM cloudflare_neuron_usage').run();
  clearAllCooldowns();
  resetCloudflareNeuronMeter();
  delete process.env.CLOUDFLARE_DAILY_NEURON_CAP;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.CLOUDFLARE_NEURON_ANALYTICS = '0';
});

describe('neuronsFor', () => {
  it('matches what Cloudflare billed for real traffic (2026-11-02/03 analytics)', () => {
    // aiInferenceAdaptiveGroups for Scout: 27,975,143 in / 14,470,965 out -> 1,804,874 neurons.
    const est = neuronsFor(SCOUT, { inputTokens: 27_975_143, outputTokens: 14_470_965 });
    expect(Math.abs(est - 1_804_874) / 1_804_874).toBeLessThan(0.005);
    // Llama 3.3 70B: 66,098,329 in / 26,251,663 out -> 7,139,169 neurons.
    const big = neuronsFor(LLAMA_70B, { inputTokens: 66_098_329, outputTokens: 26_251_663 });
    expect(Math.abs(big - 7_139_169) / 7_139_169).toBeLessThan(0.005);
  });

  it('charges an unpriced model at least as much as the dearest listed one', () => {
    const unknown = neuronsFor('@cf/new/model', { inputTokens: 1000, outputTokens: 1000 });
    expect(unknown).toBeGreaterThanOrEqual(neuronsFor('@cf/zai-org/glm-5.3', { inputTokens: 1000, outputTokens: 1000 }));
    expect(neuronsFor('@cf/new/image-model', {})).toBe(1000);
  });
});

describe('startCloudflareCall ledger', () => {
  it('charges an estimate at dispatch and corrects it on settle', () => {
    const call = startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 1000, maxOutputTokens: 500 }, T0);
    const estimated = localNeuronsToday('account-a', T0);
    expect(estimated).toBeCloseTo(neuronsFor(SCOUT, { inputTokens: 1000, outputTokens: 500 }), 5);
    call.settle({ inputTokens: 1000, outputTokens: 100 });
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(neuronsFor(SCOUT, { inputTokens: 1000, outputTokens: 100 }), 5);
  });

  it('keeps the estimate for a call that never reported back (abort, timeout)', () => {
    const call = startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 1000, maxOutputTokens: 500 }, T0);
    const estimated = localNeuronsToday('account-a', T0);
    call.settle(null);
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(estimated, 5);
  });

  it('settleAtLeast never charges less than the estimate', () => {
    const call = startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 1000, maxOutputTokens: 500 }, T0);
    const estimated = localNeuronsToday('account-a', T0);
    call.settleAtLeast({ inputTokens: 1000, outputTokens: 10 });
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(estimated, 5);
    const call2 = startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 1000, maxOutputTokens: 500 }, T0);
    call2.settleAtLeast({ inputTokens: 1000, outputTokens: 5000 });
    expect(localNeuronsToday('account-a', T0))
      .toBeCloseTo(estimated + neuronsFor(SCOUT, { inputTokens: 1000, outputTokens: 5000 }), 5);
  });

  it('refunds a call Cloudflare refused', () => {
    startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 1000 }, T0).refund();
    expect(localNeuronsToday('account-a', T0)).toBe(0);
  });

  it('meters per ACCOUNT: tokens of one account share, other accounts do not', () => {
    startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 1000, outputTokens: 100 }, T0);
    startCloudflareCall(KEY_A2, SCOUT, { inputTokens: 1000, outputTokens: 100 }, T0);
    const one = neuronsFor(SCOUT, { inputTokens: 1000, outputTokens: 100 });
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(2 * one, 5);
    expect(localNeuronsToday('account-b', T0)).toBe(0);
  });

  it('learns a model\'s typical output once a few calls have settled', () => {
    for (let i = 0; i < 3; i++) {
      startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 10 }, T0).settle({ inputTokens: 10, outputTokens: 3000 });
    }
    const before = localNeuronsToday('account-a', T0);
    startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 10 }, T0);
    expect(localNeuronsToday('account-a', T0) - before)
      .toBeCloseTo(neuronsFor(SCOUT, { inputTokens: 10, outputTokens: 3000 }), 5);
  });
});

describe('daily cap', () => {
  it('defaults below the 10K free allowance', () => {
    expect(DEFAULT_CLOUDFLARE_DAILY_NEURON_CAP).toBeLessThan(10_000);
  });

  it('refuses a call too big for what is left WITHOUT benching the account', () => {
    // 00:05 UTC, nothing used yet: one huge prompt does not fit under the cap,
    // but every ordinary request still does. Only that call may be refused.
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '1000';
    const a1 = insertKey(KEY_A1);
    getDb().prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES ('cloudflare', ?, 'Scout', 50, 50, 1)
    `).run(SCOUT);

    let err: unknown;
    try {
      startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 30_000, outputTokens: 9_000 }, T0);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CloudflareRequestTooLargeError);
    expect((err as CloudflareRequestTooLargeError).providerRejection).toBe('request');
    expect(isCloudflareNeuronsExhausted(err as Error)).toBe(false);
    expect(isOnCooldown('cloudflare', SCOUT, a1)).toBe(false);
    expect(localNeuronsToday('account-a', T0)).toBe(0);
    // A normal-sized call still goes through.
    expect(() => startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 1_000, outputTokens: 500 }, T0)).not.toThrow();
  });

  it('charges the call\'s max_tokens at dispatch, so one call cannot overshoot the cap', () => {
    // 8,000 of 9,000 used. With the average (1,024) as the output estimate a
    // call asking for max_tokens 8192 fitted, then generated all 8192 tokens
    // and pushed the account past the free 10,000 — billed on Workers Paid.
    const kimi = '@cf/moonshotai/kimi-k2.6';
    spend(KEY_A1, 326_000, 0, T0); // ~8,000 neurons of Scout
    const used = localNeuronsToday('account-a', T0);
    expect(used).toBeGreaterThan(7_000);
    expect(used).toBeLessThan(9_000);
    expect(() => startCloudflareCall(KEY_A1, kimi, { inputTokens: 1_000, maxOutputTokens: 8_192 }, T0))
      .toThrow(CloudflareRequestTooLargeError);
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(used, 5);
  });

  it('refuses a call once the cap is reached, with the Free plan\'s own 429, and benches the account', () => {
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '1000';
    const a1 = insertKey(KEY_A1);
    const a2 = insertKey(KEY_A2);
    const b = insertKey(KEY_B);
    getDb().prepare(`
      INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES ('cloudflare', ?, 'Scout', 50, 50, 1)
    `).run(SCOUT);
    // ~941 neurons of Scout, then a settled call that crosses the cap.
    startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 10_000, outputTokens: 9_000 }, T0);
    expect(cloudflareNeuronsAvailable(KEY_A1, T0)).toBe(true);
    spend(KEY_A1, 1_000, 500, T0);
    expect(cloudflareNeuronsAvailable(KEY_A1, T0)).toBe(false);

    let err: unknown;
    try {
      startCloudflareCall(KEY_A2, SCOUT, { inputTokens: 100, outputTokens: 10 }, T0);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CloudflareNeuronCapError);
    expect(isCloudflareNeuronsExhausted(err as CloudflareNeuronCapError)).toBe(true);
    expect((err as CloudflareNeuronCapError).retryAfterSec).toBe(12 * 3600);
    expect(isOnCooldown('cloudflare', SCOUT, a1)).toBe(true);
    expect(isOnCooldown('cloudflare', SCOUT, a2)).toBe(true);
    expect(isOnCooldown('cloudflare', SCOUT, b)).toBe(false);
    // A different account still has its whole allowance.
    expect(() => startCloudflareCall(KEY_B, SCOUT, { inputTokens: 10_000, outputTokens: 9_000 }, T0)).not.toThrow();
  });

  it('reports the account unavailable once it reaches the cap, and resets at midnight UTC', () => {
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '50';
    spend(KEY_A1, 10_000, 9_000, T0);
    expect(cloudflareNeuronsAvailable(KEY_A1, T0)).toBe(false);
    expect(cloudflareNeuronsAvailable(KEY_A2, T0)).toBe(false);
    expect(cloudflareNeuronsAvailable(KEY_B, T0)).toBe(true);
    const tomorrow = Date.UTC(2026, 10, 5, 0, 0, 1);
    expect(cloudflareNeuronsAvailable(KEY_A1, tomorrow)).toBe(true);
  });

  it('CLOUDFLARE_DAILY_NEURON_CAP=0 lets an operator who wants paid usage through', () => {
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '0';
    for (let i = 0; i < 5; i++) startCloudflareCall(KEY_A1, LLAMA_70B, { inputTokens: 100_000, outputTokens: 100_000 }, T0);
    expect(cloudflareNeuronsAvailable(KEY_A1, T0)).toBe(true);
    expect(localNeuronsToday('account-a', T0)).toBeGreaterThan(10_000);
  });

  it('the credential picker for embeddings/media/decisions skips a capped account', () => {
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '50';
    insertKey(KEY_A1);
    const b = insertKey(KEY_B);
    spend(KEY_A1, 10_000, 9_000);
    for (let i = 0; i < 5; i++) {
      const { credential } = reserveProviderCredential({ platform: 'cloudflare', key_id: null }, 10);
      expect(credential?.id).toBe(b);
      credential?.release();
    }
  });
});

describe('max_tokens reservation', () => {
  const KIMI = '@cf/moonshotai/kimi-k2.6';
  const scoutRow = () => getDb().prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
    VALUES ('cloudflare', ?, 'Scout', 50, 50, 1)
  `).run(SCOUT);

  it('reserves max_tokens, then settle() gives back what the call did not use', () => {
    const call = startCloudflareCall(KEY_A1, KIMI, { inputTokens: 1000, maxOutputTokens: 8192 }, T0);
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(neuronsFor(KIMI, { inputTokens: 1000, outputTokens: 8192 }), 5);
    call.settle({ inputTokens: 1000, outputTokens: 200 });
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(neuronsFor(KIMI, { inputTokens: 1000, outputTokens: 200 }), 5);
  });

  it('an aborted stream keeps its likely cost, not the whole reservation', () => {
    // Claude Code style: max_tokens 32000, the user hits Esc after 10 tokens.
    // Keeping 32000 tokens of Kimi (~11,600 neurons) would bench the account
    // on one abort; main kept the likely cost (1,024 tokens), and still does.
    const call = startCloudflareCall(KEY_A1, KIMI, { inputTokens: 1000, maxOutputTokens: 8192 }, T0);
    call.settleAtLeast({ inputTokens: 1000, outputTokens: 10 });
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(neuronsFor(KIMI, { inputTokens: 1000, outputTokens: 1024 }), 5);
    // More than the likely cost streamed before the cut: that is what stays.
    const call2 = startCloudflareCall(KEY_B, KIMI, { inputTokens: 1000, maxOutputTokens: 8192 }, T0);
    call2.settleAtLeast({ inputTokens: 1000, outputTokens: 4000 });
    expect(localNeuronsToday('account-b', T0)).toBeCloseTo(neuronsFor(KIMI, { inputTokens: 1000, outputTokens: 4000 }), 5);
  });

  it('a call with unknown usage keeps its likely cost, not the whole reservation', () => {
    startCloudflareCall(KEY_A1, KIMI, { inputTokens: 1000, maxOutputTokens: 8192 }, T0).settle(null);
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(neuronsFor(KIMI, { inputTokens: 1000, outputTokens: 1024 }), 5);
  });

  it('benches an account too close to the cap for even a small call', () => {
    // 960 of 1,000 used: no Scout call (~79 neurons for 1,024 tokens) fits.
    // Refusing call by call instead left the account routable all day, every
    // request burning a failover hop on it.
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '1000';
    const a1 = insertKey(KEY_A1);
    scoutRow();
    spend(KEY_A1, 1_000, 12_000, T0);
    const used = localNeuronsToday('account-a', T0);
    expect(used).toBeGreaterThan(921);
    expect(used).toBeLessThan(1000);
    expect(() => startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 100, maxOutputTokens: 8192 }, T0))
      .toThrow(CloudflareNeuronCapError);
    expect(isOnCooldown('cloudflare', SCOUT, a1)).toBe(true);
  });

  it('calls in flight hold their reservation but never bench the account; settling frees the room', () => {
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '1000';
    const a1 = insertKey(KEY_A1);
    scoutRow();
    const one = neuronsFor(SCOUT, { inputTokens: 0, outputTokens: 2048 }); // ~158
    const calls = [];
    for (let i = 0; i < Math.floor(1000 / one); i++) {
      calls.push(startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 0, maxOutputTokens: 2048 }, T0));
    }
    expect(calls).toHaveLength(6);
    // A seventh concurrent call does not fit beside the six reservations: it
    // alone is refused, and the account stays routable.
    expect(() => startCloudflareCall(KEY_A2, SCOUT, { inputTokens: 0, maxOutputTokens: 2048 }, T0))
      .toThrow(CloudflareRequestTooLargeError);
    expect(isOnCooldown('cloudflare', SCOUT, a1)).toBe(false);
    expect(cloudflareNeuronsAvailable(KEY_A1, T0)).toBe(true);
    // Two of them finish short: their unused reservation comes back.
    calls[0]!.settle({ inputTokens: 0, outputTokens: 100 });
    calls[1]!.settle({ inputTokens: 0, outputTokens: 100 });
    expect(() => startCloudflareCall(KEY_A2, SCOUT, { inputTokens: 0, maxOutputTokens: 2048 }, T0)).not.toThrow();
    // A refund (Cloudflare answered with an error) frees the whole reservation.
    const before = localNeuronsToday('account-a', T0);
    calls[2]!.refund();
    expect(localNeuronsToday('account-a', T0)).toBeCloseTo(before - one, 5);
  });

  it('a call reserved before midnight UTC settles on its own day; the new day starts empty', () => {
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '1000';
    const late = Date.UTC(2026, 10, 4, 23, 59, 0);
    const next = Date.UTC(2026, 10, 5, 0, 1, 0);
    const call = startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 0, maxOutputTokens: 8192 }, late);
    expect(localNeuronsToday('account-a', late)).toBeGreaterThan(600);
    expect(localNeuronsToday('account-a', next)).toBe(0);
    call.settle({ inputTokens: 0, outputTokens: 100 });
    expect(localNeuronsToday('account-a', late)).toBeCloseTo(neuronsFor(SCOUT, { outputTokens: 100 }), 5);
    expect(localNeuronsToday('account-a', next)).toBe(0);
    expect(() => startCloudflareCall(KEY_A1, SCOUT, { inputTokens: 0, maxOutputTokens: 8192 }, next)).not.toThrow();
  });
});

describe('meterCloudflare', () => {
  it('refunds an HTTP error, keeps the estimate on a timeout, and wraps a cap refusal', async () => {
    await expect(meterCloudflare(KEY_A1, SCOUT, { inputTokens: 1000 }, async () => {
      throw Object.assign(new Error('400'), { status: 400 });
    }, () => null)).rejects.toThrow('400');
    expect(localNeuronsToday('account-a', T0 + 0)).toBe(0);

    await expect(meterCloudflare(KEY_A1, SCOUT, { inputTokens: 1000 }, async () => {
      throw new Error('The operation was aborted due to timeout');
    }, () => null)).rejects.toThrow('timeout');
    expect(localNeuronsToday('account-a')).toBeGreaterThan(0);

    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '1';
    class Wrapped extends Error { status = 429; }
    await expect(meterCloudflare(KEY_A1, SCOUT, { inputTokens: 1000 }, async () => 'never', () => null,
      e => new Wrapped(e.message))).rejects.toBeInstanceOf(Wrapped);
  });
});

describe('Cloudflare\'s own count (analytics)', () => {
  it('uses the higher of the ledger and Cloudflare\'s count', async () => {
    process.env.CLOUDFLARE_NEURON_ANALYTICS = '1';
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 9_500 } }] }] } },
      errors: null,
    }), { status: 200 }));
    expect(await refreshRemoteNeurons(KEY_A1, T0)).toBe(9_500);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-one');
    expect(cloudflareNeuronsUsedToday('account-a', T0)).toBe(9_500);
    expect(cloudflareNeuronsAvailable(KEY_A1, T0)).toBe(false);
  });

  it('a token without analytics access changes nothing', async () => {
    process.env.CLOUDFLARE_NEURON_ANALYTICS = '1';
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: null, errors: [{ message: 'not authorized for that account' }],
    }), { status: 200 }));
    expect(await refreshRemoteNeurons(KEY_A1, T0)).toBeNull();
    expect(cloudflareNeuronsUsedToday('account-a', T0)).toBe(0);
  });
});

describe('CloudflareProvider under the meter', () => {
  const completion = {
    id: 'x', object: 'chat.completion', created: 1, model: SCOUT,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2_000, completion_tokens: 400, total_tokens: 2_400 },
  };

  it('settles a completed call on the usage Cloudflare reports', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(completion), { status: 200 }));
    await new CloudflareProvider().chatCompletion(KEY_A1, [{ role: 'user', content: 'hello' }], SCOUT);
    expect(localNeuronsToday('account-a')).toBeCloseTo(neuronsFor(SCOUT, { inputTokens: 2_000, outputTokens: 400 }), 5);
  });

  it('never reaches Cloudflare once the account is at its cap', async () => {
    process.env.CLOUDFLARE_DAILY_NEURON_CAP = '10';
    spend(KEY_A1, 10_000, 9_000);
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(completion), { status: 200 }));
    await expect(new CloudflareProvider().chatCompletion(KEY_A1, [{ role: 'user', content: 'hello' }], SCOUT))
      .rejects.toThrow(/daily free allocation of neurons/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refunds an error answer', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: 'bad' }] }), { status: 400 }));
    await expect(new CloudflareProvider().chatCompletion(KEY_A1, [{ role: 'user', content: 'hello' }], SCOUT)).rejects.toThrow();
    expect(localNeuronsToday('account-a')).toBe(0);
  });

  it('a call that gets no answer (timeout, transport) keeps its likely cost, not its max_tokens reservation', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('The operation was aborted due to timeout'));
    await expect(new CloudflareProvider().chatCompletion(KEY_A1, [{ role: 'user', content: 'x'.repeat(400) }], SCOUT, { max_tokens: 8192 }))
      .rejects.toThrow(/aborted/);
    expect(localNeuronsToday('account-a')).toBeCloseTo(neuronsFor(SCOUT, { inputTokens: 100, outputTokens: 1024 }), 0);
  });

  it('settles a stream on its streamed text when Cloudflare sends no usage', async () => {
    const sse = [
      `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: SCOUT, choices: [{ index: 0, delta: { content: 'a'.repeat(4000) }, finish_reason: null }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const chunks = [];
    for await (const c of new CloudflareProvider().streamChatCompletion(KEY_A1, [{ role: 'user', content: 'x'.repeat(400) }], SCOUT)) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    expect(localNeuronsToday('account-a')).toBeCloseTo(neuronsFor(SCOUT, { inputTokens: 100, outputTokens: 1000 }), 5);
  });
});
