// Idempotency-Key support for non-streaming chat requests.
//
// Free-tier quota is a scarce asset: a client that times out and retries the
// same non-streaming request currently burns a second free-tier slot for an
// answer it already received. This module lets callers opt in to idempotent
// retries via the `Idempotency-Key` header:
//
//   - Only a SHA-256 hash of the caller's key is stored, never the raw key.
//   - A request fingerprint (canonical SHA-256 of model + messages + sampling
//     params) is bound to the key, so reusing the same key with different
//     content is a 409 conflict, not a silent wrong answer.
//   - On success the original HTTP status + body are persisted to SQLite and
//     replayed for later requests with the same key + fingerprint — zero
//     provider cost, mirroring what the response cache does for exact-match
//     hits, but scoped per caller (key) instead of per request content.
//   - A duplicate that arrives while the original request is still running is
//     NOT deduplicated: only completed responses are claimed, so both attempts
//     execute. Guarding the in-flight window needs a pending-claim state with
//     its own (short) TTL so a crash cannot wedge a key for a day; that is
//     deliberately out of scope here.
//
// Storage is the idempotency_claims table (see db/migrations). All writes are
// guarded so a DB failure degrades to "no idempotency" rather than throwing in
// the proxy hot path (mirrors services/cache.ts).

import crypto from 'crypto';
import { getDb } from '../db/index.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

// ── Config (read per call so tests can flip it live) ──

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Replay window for completed idempotent responses (default 24h). */
export function idempotencyTtlMs(): number {
  return envNum('IDEMPOTENCY_TTL_MS', 24 * 60 * 60 * 1000);
}

// ── Key / fingerprint helpers ──

export function hashIdempotencyKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Canonical fingerprint of the request content that produced a response. */
export function computeIdempotencyFingerprint(input: {
  model?: string;
  messages: ChatMessage[];
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  tools?: unknown;
  tool_choice?: unknown;
}): string {
  const stable = JSON.stringify({
    model: input.model ?? null,
    messages: input.messages,
    temperature: input.temperature ?? null,
    top_p: input.top_p ?? null,
    max_tokens: input.max_tokens ?? null,
    tools: input.tools ?? null,
    tool_choice: input.tool_choice ?? null,
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

// ── Claim / replay ──

export type IdempotencyClaimResult =
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'miss' };

/**
 * Attempt to claim a completed idempotent response for the given key hash.
 *
 * Returns:
 *   - { kind: 'replay', ... } when a completed claim with the SAME fingerprint
 *     exists and is still inside the replay window — the caller should replay
 *     it verbatim without touching a provider.
 *   - { kind: 'conflict' } when a completed claim exists but its fingerprint
 *     differs — the caller must return 409 idempotency_key_conflict.
 *   - { kind: 'miss' } when there is no usable claim — proceed normally and
 *     persist the result on success.
 */
export function lookupIdempotencyReplay(
  keyHash: string,
  fingerprint: string,
  now = Date.now(),
): IdempotencyClaimResult {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT request_fingerprint, response_status, response_body
         FROM idempotency_claims
        WHERE key_hash = ? AND expires_at_ms > ?`,
    ).get(keyHash, now) as
      | { request_fingerprint: string; response_status: number; response_body: string }
      | undefined;
    if (!row) return { kind: 'miss' };
    if (row.request_fingerprint !== fingerprint) return { kind: 'conflict' };
    let body: unknown;
    try {
      body = JSON.parse(row.response_body);
    } catch {
      // Corrupt stored body — treat as a miss and let the caller regenerate.
      return { kind: 'miss' };
    }
    return { kind: 'replay', status: row.response_status, body };
  } catch {
    // DB unavailable: degrade to no idempotency rather than failing the request.
    return { kind: 'miss' };
  }
}

/**
 * Persist a completed response for future replays. Replaces any previous claim
 * for the same key hash. Expired rows are swept lazily for this key first.
 */
export function storeIdempotencyResult(
  keyHash: string,
  fingerprint: string,
  status: number,
  body: unknown,
  executionId?: string,
  now = Date.now(),
): void {
  try {
    const db = getDb();
    const ttl = idempotencyTtlMs();
    db.prepare('DELETE FROM idempotency_claims WHERE key_hash = ? AND expires_at_ms <= ?')
      .run(keyHash, now);
    db.prepare(
      `INSERT INTO idempotency_claims
         (key_hash, request_fingerprint, response_status, response_body, execution_id, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         request_fingerprint = excluded.request_fingerprint,
         response_status = excluded.response_status,
         response_body = excluded.response_body,
         execution_id = excluded.execution_id,
         created_at_ms = excluded.created_at_ms,
         expires_at_ms = excluded.expires_at_ms`,
    ).run(
      keyHash,
      fingerprint,
      status,
      JSON.stringify(body),
      executionId ?? null,
      now,
      now + ttl,
    );
  } catch {
    // DB unavailable: idempotency is best-effort; the response already went out.
  }
}

/**
 * Delete an idempotency claim (e.g. after a failed generation that the caller
 * does not want replayed). Fail-safe.
 */
export function clearIdempotencyResult(keyHash: string): void {
  try {
    getDb().prepare('DELETE FROM idempotency_claims WHERE key_hash = ?').run(keyHash);
  } catch {
    // best-effort
  }
}

/** Normalize an Idempotency-Key header: trim, non-empty, ≤ 255 UTF-8 bytes. */
export function normalizeIdempotencyKey(raw: string | string[] | undefined): string | null {
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = (value ?? '').trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > 255) return null;
  return trimmed;
}
