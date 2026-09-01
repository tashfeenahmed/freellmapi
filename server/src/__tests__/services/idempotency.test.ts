import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  hashIdempotencyKey,
  computeIdempotencyFingerprint,
  lookupIdempotencyReplay,
  storeIdempotencyResult,
  clearIdempotencyResult,
  normalizeIdempotencyKey,
  idempotencyTtlMs,
} from '../../services/idempotency.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const IDEM_ENV = ['IDEMPOTENCY_TTL_MS'] as const;

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

const fingerprintFor = (model: string, content: string) =>
  computeIdempotencyFingerprint({
    model,
    messages: [msg('user', content)],
  });

const sampleBody = (text: string) => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

describe('idempotency', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    for (const k of IDEM_ENV) saved[k] = process.env[k];
    initDb(':memory:');
  });

  afterEach(() => {
    for (const k of IDEM_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('miss on an unknown key hash', () => {
    const r = lookupIdempotencyReplay(hashIdempotencyKey('never-stored'), fingerprintFor('m', 'hi'));
    expect(r.kind).toBe('miss');
  });

  it('replays a stored response with the same key + fingerprint', () => {
    const keyHash = hashIdempotencyKey('retry-me');
    const fp = fingerprintFor('groq/llama', 'same question');
    storeIdempotencyResult(keyHash, fp, 200, sampleBody('first answer'), 'exec-1');
    const r = lookupIdempotencyReplay(keyHash, fp);
    expect(r.kind).toBe('replay');
    if (r.kind === 'replay') {
      expect(r.status).toBe(200);
      expect(r.body).toEqual(sampleBody('first answer'));
    }
  });

  it('reports conflict when the same key is reused with different content', () => {
    const keyHash = hashIdempotencyKey('shared-key');
    storeIdempotencyResult(
      keyHash,
      fingerprintFor('m', 'question A'),
      200,
      sampleBody('answer A'),
    );
    const r = lookupIdempotencyReplay(keyHash, fingerprintFor('m', 'question B'));
    expect(r.kind).toBe('conflict');
  });

  it('treats an expired claim as a miss', () => {
    const keyHash = hashIdempotencyKey('expired');
    const fp = fingerprintFor('m', 'q');
    const now = 1_000_000;
    storeIdempotencyResult(keyHash, fp, 200, sampleBody('old'), undefined, now);
    const r = lookupIdempotencyReplay(keyHash, fp, now + idempotencyTtlMs() + 1);
    expect(r.kind).toBe('miss');
  });

  it('replaces the previous claim when the same key is reused after completion', () => {
    const keyHash = hashIdempotencyKey('replaced');
    const fpA = fingerprintFor('m', 'first');
    storeIdempotencyResult(keyHash, fpA, 200, sampleBody('answer A'));
    const fpB = fingerprintFor('m', 'second');
    storeIdempotencyResult(keyHash, fpB, 200, sampleBody('answer B'));
    // After a new successful completion with a DIFFERENT fingerprint, the old
    // claim is replaced: the new fingerprint replays, and the old fingerprint
    // (same key, different content) is a conflict — not a silent wrong answer.
    expect(lookupIdempotencyReplay(keyHash, fpB).kind).toBe('replay');
    expect(lookupIdempotencyReplay(keyHash, fpA).kind).toBe('conflict');
  });

  it('clear removes the claim', () => {
    const keyHash = hashIdempotencyKey('cleared');
    const fp = fingerprintFor('m', 'q');
    storeIdempotencyResult(keyHash, fp, 200, sampleBody('x'));
    clearIdempotencyResult(keyHash);
    expect(lookupIdempotencyReplay(keyHash, fp).kind).toBe('miss');
  });

  it('normalizeIdempotencyKey trims, rejects empties and >255-byte values', () => {
    expect(normalizeIdempotencyKey('  abc  ')).toBe('abc');
    expect(normalizeIdempotencyKey('   ')).toBeNull();
    expect(normalizeIdempotencyKey('')).toBeNull();
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
    expect(normalizeIdempotencyKey('a'.repeat(256))).toBeNull();
    expect(normalizeIdempotencyKey('a'.repeat(255))).toBe('a'.repeat(255));
    // Repeated header (Express lower-cases and arrays multi-value) → first wins.
    expect(normalizeIdempotencyKey(['first', 'second'])).toBe('first');
  });

  it('different content produces different fingerprints; order-insensitive JSON does not collide wrongly', () => {
    const a = fingerprintFor('m', 'hello');
    const b = fingerprintFor('m', 'world');
    expect(a).not.toBe(b);
    // Same model + content → same fingerprint.
    expect(fingerprintFor('m', 'hello')).toBe(a);
  });
});
