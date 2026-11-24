import { describe, it, expect } from 'vitest';
import { isUpstreamClassificationOutput, isInBandQuotaNotice } from '../../lib/error-classify.js';

/**
 * #809: kilo's free relay sometimes answers with a bare "safe"/"unsafe" — an
 * upstream content filter's verdict standing in for the model's reply. The
 * surfaces treat that as an empty completion and fail over.
 *
 * The rule is deliberately scoped to that relay. "safe"/"unsafe" is a perfectly
 * valid one-word answer for moderation and guard-model work, so firing it on
 * every platform would discard correct responses and burn the whole fallback
 * chain for anyone doing classification.
 */
describe('isUpstreamClassificationOutput (#809)', () => {
  it('flags a bare classification verdict from the kilo relay', () => {
    expect(isUpstreamClassificationOutput('safe', 'kilo')).toBe(true);
    expect(isUpstreamClassificationOutput('unsafe', 'kilo')).toBe(true);
  });

  it('ignores surrounding whitespace and case', () => {
    expect(isUpstreamClassificationOutput('  Safe \n', 'kilo')).toBe(true);
    expect(isUpstreamClassificationOutput('UNSAFE', 'kilo')).toBe(true);
  });

  it('leaves the same answer alone on every other platform', () => {
    // A moderation/guard workload legitimately answering one word must survive.
    for (const platform of ['groq', 'cerebras', 'openrouter', 'custom', 'gemini']) {
      expect(isUpstreamClassificationOutput('safe', platform)).toBe(false);
      expect(isUpstreamClassificationOutput('unsafe', platform)).toBe(false);
    }
  });

  it('does not fire when the platform is unknown', () => {
    expect(isUpstreamClassificationOutput('safe')).toBe(false);
    expect(isUpstreamClassificationOutput('safe', '')).toBe(false);
    expect(isUpstreamClassificationOutput('safe', undefined)).toBe(false);
  });

  it('matches the platform case-insensitively', () => {
    expect(isUpstreamClassificationOutput('safe', 'Kilo')).toBe(true);
  });

  it('leaves a real answer that merely contains the word alone', () => {
    expect(isUpstreamClassificationOutput('This code is safe to run.', 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput('safe mode', 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput('unsafe: buffer overflow on line 12', 'kilo')).toBe(false);
  });

  it('ignores empty and non-string content', () => {
    expect(isUpstreamClassificationOutput('', 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput(null, 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput(undefined, 'kilo')).toBe(false);
    expect(isUpstreamClassificationOutput(42, 'kilo')).toBe(false);
  });
});

/**
 * In-band relay quota notices: aihubmix `*-free` models answer HTTP 200 with a
 * quota/abuse-prevention notice as the "completion" (0 output tokens). The
 * surfaces must treat it like an empty completion and fail over — on every
 * platform, since the relays sit behind platform 'custom'.
 */
describe('in-band relay quota notices', () => {
  const NOTICE = 'Sorry, to prevent abuse of free resources, accounts that have not been recharged can only try 10 times. Please recharge to continue.';

  it('flags the observed aihubmix notice on any platform', () => {
    expect(isInBandQuotaNotice(NOTICE)).toBe(true);
    for (const platform of ['custom', 'kilo', 'openrouter', undefined]) {
      expect(isUpstreamClassificationOutput(NOTICE, platform)).toBe(true);
    }
  });

  it('flags close variants (no "Sorry", leading whitespace, case)', () => {
    expect(isInBandQuotaNotice('To prevent abuse of free resources, accounts that have not been recharged can only try 10 times')).toBe(true);
    expect(isInBandQuotaNotice('\n\n  SORRY! Accounts that have not been recharged can only try 10 times per day.')).toBe(true);
    expect(isInBandQuotaNotice('Sorry: to prevent abuse of free resources, please try later.')).toBe(true);
  });

  it('leaves ordinary answers alone', () => {
    expect(isInBandQuotaNotice('pong')).toBe(false);
    expect(isInBandQuotaNotice('Sorry, I cannot help with that request.')).toBe(false);
    expect(isInBandQuotaNotice('Sorry for the confusion — here is the corrected code.')).toBe(false);
    expect(isInBandQuotaNotice('Insufficient balance errors usually mean your account needs a top-up.')).toBe(false);
    expect(isInBandQuotaNotice('Please recharge the battery before the test.')).toBe(false);
  });

  it('leaves an answer that quotes or discusses the notice alone (not anchored at the start)', () => {
    expect(isInBandQuotaNotice('The relay replied: "Sorry, to prevent abuse of free resources, accounts that have not been recharged can only try 10 times".')).toBe(false);
    expect(isInBandQuotaNotice('Some providers limit accounts that have not been recharged to prevent abuse of free resources.')).toBe(false);
  });

  it('leaves a long answer that happens to start with the phrase alone', () => {
    const long = 'To prevent abuse of free resources, ' + 'rate limiting works by tracking requests per key. '.repeat(20);
    expect(long.length).toBeGreaterThan(600);
    expect(isInBandQuotaNotice(long)).toBe(false);
  });

  it('ignores empty and non-string content', () => {
    expect(isInBandQuotaNotice('')).toBe(false);
    expect(isInBandQuotaNotice('   ')).toBe(false);
    expect(isInBandQuotaNotice(null)).toBe(false);
    expect(isInBandQuotaNotice(42)).toBe(false);
  });

  it('keeps the #809 rule unchanged: "safe" still only fires on kilo', () => {
    expect(isUpstreamClassificationOutput('safe', 'custom')).toBe(false);
    expect(isUpstreamClassificationOutput('safe', 'kilo')).toBe(true);
  });
});
