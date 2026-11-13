import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { parseProviderLimit, learnLimitFromError } from '../../services/ratelimit.js';

describe('parseProviderLimit', () => {
  it('parses a Groq 413 TPM body', () => {
    const msg = 'Groq API error 413: Request too large for model `llama-4-scout` in organization org_x service tier `on_demand` on tokens per minute (TPM): Limit 30000, Requested 33476. Please try again later.';
    expect(parseProviderLimit(msg)).toEqual({ kind: 'tpm', limit: 30000 });
  });

  it('parses RPM / RPD / TPD axes', () => {
    expect(parseProviderLimit('on requests per minute (RPM): Limit 30, Requested 31')).toEqual({ kind: 'rpm', limit: 30 });
    expect(parseProviderLimit('on requests per day (RPD): Limit 1000, Used 1000')).toEqual({ kind: 'rpd', limit: 1000 });
    expect(parseProviderLimit('on tokens per day (TPD): Limit 500000')).toEqual({ kind: 'tpd', limit: 500000 });
  });

  it('strips thousands separators in the limit', () => {
    expect(parseProviderLimit('tokens per minute (TPM): Limit 1,000,000, Requested 2,000,000')).toEqual({ kind: 'tpm', limit: 1_000_000 });
  });

  it('prefers the token axis when both tokens and requests are mentioned', () => {
    expect(parseProviderLimit('requests per minute and tokens per minute (TPM): Limit 8000')).toEqual({ kind: 'tpm', limit: 8000 });
  });

  // Groq orgs with split per-minute limits name the direction: ITPM counts
  // prompt tokens only, OTPM counts expected completion tokens only. Neither
  // is the combined TPM the router gates on (live bodies, org redacted).
  const GROQ_OTPM = 'Groq API error 429: Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1838. The request\'s expected output tokens exceed the limit.';
  const GROQ_ITPM = 'Groq API error 413: Request too large for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on input tokens per minute (ITPM): Limit 7000, Requested 16136, please reduce your message size and try again.';

  it('reads a Groq OTPM body as the output axis, not TPM', () => {
    expect(parseProviderLimit(GROQ_OTPM)).toEqual({ kind: 'otpm', limit: 1000 });
  });

  it('reads a Groq ITPM body as the input axis, not TPM', () => {
    expect(parseProviderLimit(GROQ_ITPM)).toEqual({ kind: 'itpm', limit: 7000 });
  });

  it('reads bare OTPM / ITPM abbreviations', () => {
    expect(parseProviderLimit('OTPM: Limit 1000, Requested 1838')).toEqual({ kind: 'otpm', limit: 1000 });
    expect(parseProviderLimit('ITPM: Limit 7000, Requested 9000')).toEqual({ kind: 'itpm', limit: 7000 });
  });

  it('returns null without a confident axis even when a Limit is present', () => {
    expect(parseProviderLimit('Some limit: 9999 was exceeded')).toBeNull();
  });

  it('returns null when there is no numeric limit', () => {
    expect(parseProviderLimit('tokens per minute (TPM) exceeded, slow down')).toBeNull();
  });

  it('returns null for empty / non-limit errors', () => {
    expect(parseProviderLimit('')).toBeNull();
    expect(parseProviderLimit(undefined)).toBeNull();
    expect(parseProviderLimit('API error 500: internal server error')).toBeNull();
  });
});

describe('learnLimitFromError (persistence)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function insertModel(fields: { tpm?: number | null; rpm?: number | null } = {}): number {
    const info = getDb().prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, tpm_limit, rpm_limit)
       VALUES ('groq', ?, 'M', 50, 50, ?, ?)`,
    ).run(`m-${Math.random().toString(36).slice(2)}`, fields.tpm ?? null, fields.rpm ?? null);
    return info.lastInsertRowid as number;
  }
  const tpmCol = (id: number) => (getDb().prepare('SELECT tpm_limit FROM models WHERE id = ?').get(id) as { tpm_limit: number | null }).tpm_limit;

  it('fills a NULL limit from a learned ceiling', () => {
    const id = insertModel({ tpm: null });
    const r = learnLimitFromError(id, { message: 'tokens per minute (TPM): Limit 6000, Requested 9000' });
    expect(r).toEqual({ kind: 'tpm', limit: 6000 });
    expect(tpmCol(id)).toBe(6000);
  });

  it('lowers an existing limit that was too high', () => {
    const id = insertModel({ tpm: 40000 });
    const r = learnLimitFromError(id, { message: 'tokens per minute (TPM): Limit 30000, Requested 33000' });
    expect(r).toEqual({ kind: 'tpm', limit: 30000 });
    expect(tpmCol(id)).toBe(30000);
  });

  it('never RAISES an already-lower limit', () => {
    const id = insertModel({ tpm: 6000 });
    const r = learnLimitFromError(id, { message: 'tokens per minute (TPM): Limit 30000, Requested 33000' });
    expect(r).toBeNull();
    expect(tpmCol(id)).toBe(6000);
  });

  it('is a no-op for an error with no parseable limit', () => {
    const id = insertModel({ tpm: 12345 });
    const r = learnLimitFromError(id, { message: 'API error 500: internal server error' });
    expect(r).toBeNull();
    expect(tpmCol(id)).toBe(12345);
  });

  it('writes to the correct column per axis (RPM)', () => {
    const id = insertModel({ rpm: null });
    learnLimitFromError(id, { message: 'requests per minute (RPM): Limit 20, Requested 21' });
    const rpm = (getDb().prepare('SELECT rpm_limit FROM models WHERE id = ?').get(id) as { rpm_limit: number | null }).rpm_limit;
    expect(rpm).toBe(20);
  });

  it('never writes an OTPM (output-only) ceiling into tpm_limit', () => {
    const id = insertModel({ tpm: 7000 });
    const r = learnLimitFromError(id, { message: 'on output tokens per minute (OTPM): Limit 1000, Requested 1838' });
    expect(r).toBeNull();
    expect(tpmCol(id)).toBe(7000);
  });

  it('leaves a NULL tpm_limit alone on an OTPM rejection', () => {
    const id = insertModel({ tpm: null });
    learnLimitFromError(id, { message: 'on output tokens per minute (OTPM): Limit 1000, Requested 1838' });
    expect(tpmCol(id)).toBeNull();
  });

  it('lowers tpm_limit to an ITPM ceiling (input is part of every request, so it is a safe bound)', () => {
    const id = insertModel({ tpm: 70000 });
    const r = learnLimitFromError(id, { message: 'on input tokens per minute (ITPM): Limit 7000, Requested 16136' });
    expect(r).toEqual({ kind: 'itpm', limit: 7000 });
    expect(tpmCol(id)).toBe(7000);
  });
});
