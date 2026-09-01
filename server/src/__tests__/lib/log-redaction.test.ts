import { describe, it, expect, afterEach } from 'vitest';
import { redactSecrets, installLogRedaction } from '../../lib/log-redaction.js';

/**
 * Fixtures are assembled at runtime rather than written out as literals.
 *
 * These patterns can only be exercised by strings that look like credentials, but
 * a source file holding such a literal is indistinguishable from a real leak to
 * GitHub push protection and to any other scanner — this file was rejected once
 * for exactly that. Building each value from a vendor prefix plus deterministic
 * filler keeps the coverage while guaranteeing the repo contains no credential,
 * synthetic or otherwise. The stride-based filler is also low-entropy on purpose,
 * so it cannot be mistaken for a live key.
 */
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';

function filler(length: number, charset: string = ALNUM): string {
  let out = '';
  for (let i = 0; i < length; i++) out += charset[(i * 7 + 3) % charset.length];
  return out;
}

// [label, prefix, body length, charset] — lengths mirror each vendor's real format.
const SPECS: Array<[string, string, number, string]> = [
  ['Google', 'AIza', 35, ALNUM],
  ['Groq', 'gsk_', 52, ALNUM],
  ['Cerebras', 'csk-', 48, LOWER],
  ['NVIDIA', 'nvapi-', 64, ALNUM],
  ['GitHub PAT', 'github_pat_', 82, ALNUM],
  ['HuggingFace', 'hf_', 34, ALNUM],
  ['OpenRouter', 'sk-or-v1-', 64, HEX],
  ['Cloudflare', 'cfut_', 44, ALNUM],
  ['Vercel', 'vck_', 56, ALNUM],
  ['Aion', 'alv2_', 43, ALNUM],
  ['Pollinations', 'sk_', 32, ALNUM],
  ['Mistral (bare)', '', 32, ALNUM],
  ['Own gateway key', 'freellmapi-', 48, HEX],
];

const SAMPLES: Array<[string, string]> = SPECS.map(
  ([label, prefix, len, charset]) => [label, prefix + filler(len, charset)],
);

// Dotted composite shape (Chutes / Z.ai / Ollama cloud): id.id.secret
SAMPLES.push(['Chutes', `cpk_${filler(32, HEX)}.${filler(32, HEX)}.${filler(32)}`]);

const GOOGLE_LIKE = `AIza${filler(35)}`;
const GROQ_LIKE = `gsk_${filler(52)}`;
const UNIFIED_LIKE = `freellmapi-${filler(48, HEX)}`;

describe('redactSecrets', () => {
  for (const [label, secret] of SAMPLES) {
    it(`redacts a ${label} key`, () => {
      const out = redactSecrets(`request failed with key ${secret} on attempt 2`);
      expect(out).not.toContain(secret);
      expect(out).toContain('attempt 2');
    });
  }

  it('redacts a key embedded in a URL query string', () => {
    const secret = GOOGLE_LIKE;
    const out = redactSecrets(
      `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent?key=${secret} 429`,
    );
    expect(out).not.toContain(secret);
    // The URL itself must survive — it is the diagnostic value of the line.
    expect(out).toContain('generativelanguage.googleapis.com');
    expect(out).toContain('429');
  });

  it('redacts Authorization bearer tokens', () => {
    const out = redactSecrets('headers: { Authorization: Bearer abc123def456ghi789jkl012 }');
    expect(out).not.toContain('abc123def456ghi789jkl012');
    expect(out).toContain('Bearer [redacted]');
  });

  it('redacts an x-goog-api-key header value', () => {
    const secret = GOOGLE_LIKE;
    const out = redactSecrets(`{"x-goog-api-key":"${secret}"}`);
    expect(out).not.toContain(secret);
  });

  it('redacts assignment forms for secret-ish names', () => {
    const out = redactSecrets('ENCRYPTION_KEY=0123456789abcdef api_key: swordfishsecret');
    expect(out).not.toContain('0123456789abcdef');
    expect(out).not.toContain('swordfishsecret');
  });

  it('leaves ordinary log lines untouched', () => {
    const line = 'routed groq/llama-3.3-70b in 412ms (attempt 1, 250 tokens)';
    expect(redactSecrets(line)).toBe(line);
  });

  it('does not mangle short identifiers or model names', () => {
    const line = 'model gemini-3-pro-preview key_id 42 status healthy';
    expect(redactSecrets(line)).toBe(line);
  });

  it('emits exactly one marker when two patterns cover the same value', () => {
    // "API key: freellmapi-..." matches both the prefix rule and the key=value
    // rule; without a guard the second pass rewrote the first marker and left a
    // trailing bracket ("[redacted-key]]").
    const out = redactSecrets(
      `  Your unified API key: ${UNIFIED_LIKE}`,
    );
    expect(out).not.toContain(']]');
    expect(out.match(/\[redacted/g)).toHaveLength(1);
  });

  it('leaves a long run of one repeated character alone', () => {
    // The 32+ char catch-all is an entropy heuristic, and a run of a single
    // character has none: separator rules, padding and progress output are not
    // credentials, and redacting them made real output unreadable while
    // protecting nothing.
    const line = `divider ${'a'.repeat(36)} end`;
    expect(redactSecrets(line)).toBe(line);
    expect(redactSecrets(`${'='.repeat(40)}`)).toBe('='.repeat(40));
  });

  it('still redacts a genuine high-entropy 32-char token', () => {
    // The guard above must not have opened a hole: two distinct characters in
    // the first 32 is all it takes to be caught, which every real key is.
    const secret = filler(32);
    const out = redactSecrets(`token ${secret} rejected`);
    expect(out).not.toContain(secret);
    expect(out).toContain('[redacted-token]');
    expect(out).toContain('rejected');
  });

  it('is idempotent — redacting twice changes nothing', () => {
    const once = redactSecrets('Authorization: Bearer abc123def456ghi789jkl012');
    expect(redactSecrets(once)).toBe(once);
  });
});

describe('installLogRedaction', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('redacts secrets passed to console.log and console.error', () => {
    const seen: unknown[][] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => { seen.push(args); };
    console.error = (...args: unknown[]) => { seen.push(args); };

    restore = installLogRedaction();
    const secret = GROQ_LIKE;
    console.log(`using ${secret}`);
    console.error(new Error(`auth failed for ${secret}`));

    restore();
    console.log = origLog;
    console.error = origErr;
    restore = null;

    expect(seen).toHaveLength(2);
    expect(String(seen[0]![0])).not.toContain(secret);
    const err = seen[1]![0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(secret);
  });

  it('redacts secrets nested inside a logged object, keeping it an object', () => {
    const seen: unknown[][] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { seen.push(args); };

    restore = installLogRedaction();
    const secret = GOOGLE_LIKE;
    console.log({ platform: 'google', apiKey: secret });

    restore();
    console.log = origLog;
    restore = null;

    const logged = seen[0]![0] as Record<string, unknown>;
    expect(typeof logged).toBe('object');
    expect(logged.platform).toBe('google');
    expect(JSON.stringify(logged)).not.toContain(secret);
  });

  it('passes through values it cannot serialise', () => {
    const seen: unknown[][] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { seen.push(args); };

    restore = installLogRedaction();
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    console.log(cyclic);

    restore();
    console.log = origLog;
    restore = null;

    expect(seen[0]![0]).toBe(cyclic);
  });

  it('is idempotent', () => {
    restore = installLogRedaction();
    const second = installLogRedaction();
    second();
    const seen: unknown[][] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { seen.push(args); };
    console.log('plain line');
    console.log = origLog;
    expect(String(seen[0]![0])).toBe('plain line');
  });
});
