import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';

const FAILURE_THRESHOLD = 3;
const FAILURE_WINDOW_MS = 60_000;
const BASE_OPEN_MS = 30_000;
const MAX_OPEN_MS = 5 * 60_000;
const PROBE_LEASE_MS = 30_000;
const CLOSED_CACHE_MS = 1_000;

interface CircuitRow {
  failure_count: number;
  window_started_at_ms: number;
  open_until_ms: number | null;
  probe_lease_until_ms: number | null;
}

export type CircuitAdmission =
  | { allowed: true; probe: boolean }
  | { allowed: false; retryAt: number };

interface CachedCircuit {
  database: Db;
  expiresAt: number;
  row?: CircuitRow;
}

const admissionCache = new Map<string, CachedCircuit>();

function cacheKey(platform: string, endpointScope: string): string {
  return JSON.stringify([platform, endpointScope]);
}

function readCircuit(db: Db, platform: string, endpointScope: string): CircuitRow | undefined {
  return db.prepare(`
    SELECT failure_count, window_started_at_ms, open_until_ms, probe_lease_until_ms
    FROM provider_circuit_breakers
    WHERE platform = ? AND endpoint_scope = ?
  `).get(platform, endpointScope) as CircuitRow | undefined;
}

function currentCircuit(db: Db, platform: string, endpointScope: string, now: number): CircuitRow | undefined {
  const key = cacheKey(platform, endpointScope);
  const cached = admissionCache.get(key);
  if (cached?.database === db && cached.expiresAt > now) return cached.row;
  const row = readCircuit(db, platform, endpointScope);
  admissionCache.set(key, { database: db, expiresAt: now + CLOSED_CACHE_MS, row });
  return row;
}

export function acquireProviderCircuit(
  platform: string,
  endpointScope = '',
  now = Date.now(),
): CircuitAdmission {
  const db = getDb();
  const row = currentCircuit(db, platform, endpointScope, now);
  if (!row || row.open_until_ms == null) return { allowed: true, probe: false };
  if (row.open_until_ms > now) return { allowed: false, retryAt: row.open_until_ms };
  if (row.probe_lease_until_ms != null && row.probe_lease_until_ms > now) {
    return { allowed: false, retryAt: row.probe_lease_until_ms };
  }
  return db.transaction(() => {
    const fresh = readCircuit(db, platform, endpointScope);
    if (!fresh || fresh.open_until_ms == null) {
      admissionCache.set(cacheKey(platform, endpointScope), { database: db, expiresAt: now + CLOSED_CACHE_MS, row: fresh });
      return { allowed: true, probe: false } as const;
    }
    if (fresh.open_until_ms > now) {
      admissionCache.set(cacheKey(platform, endpointScope), { database: db, expiresAt: now + CLOSED_CACHE_MS, row: fresh });
      return { allowed: false, retryAt: fresh.open_until_ms } as const;
    }
    if (fresh.probe_lease_until_ms != null && fresh.probe_lease_until_ms > now) {
      admissionCache.set(cacheKey(platform, endpointScope), { database: db, expiresAt: now + CLOSED_CACHE_MS, row: fresh });
      return { allowed: false, retryAt: fresh.probe_lease_until_ms } as const;
    }
    const probeLeaseUntil = now + PROBE_LEASE_MS;
    db.prepare(`
      UPDATE provider_circuit_breakers
      SET probe_lease_until_ms = ?, updated_at_ms = ?
      WHERE platform = ? AND endpoint_scope = ?
    `).run(probeLeaseUntil, now, platform, endpointScope);
    admissionCache.set(cacheKey(platform, endpointScope), {
      database: db,
      expiresAt: now + CLOSED_CACHE_MS,
      row: { ...fresh, probe_lease_until_ms: probeLeaseUntil },
    });
    return { allowed: true, probe: true } as const;
  })();
}

export function recordProviderCircuitFailure(
  platform: string,
  endpointScope = '',
  now = Date.now(),
): void {
  const db = getDb();
  db.transaction(() => {
    const row = readCircuit(db, platform, endpointScope);
    const continueFailures = row != null
      && (row.open_until_ms != null || now - row.window_started_at_ms <= FAILURE_WINDOW_MS);
    const failureCount = continueFailures && row ? row.failure_count + 1 : 1;
    const windowStartedAt = continueFailures && row ? row.window_started_at_ms : now;
    const opens = failureCount >= FAILURE_THRESHOLD;
    const backoffExponent = Math.max(0, failureCount - FAILURE_THRESHOLD);
    const openDuration = Math.min(MAX_OPEN_MS, BASE_OPEN_MS * (2 ** backoffExponent));
    const openUntil = opens ? now + openDuration : null;
    db.prepare(`
      INSERT INTO provider_circuit_breakers (
        platform, endpoint_scope, failure_count, window_started_at_ms,
        open_until_ms, probe_lease_until_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(platform, endpoint_scope) DO UPDATE SET
        failure_count = excluded.failure_count,
        window_started_at_ms = excluded.window_started_at_ms,
        open_until_ms = excluded.open_until_ms,
        probe_lease_until_ms = NULL,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      platform,
      endpointScope,
      failureCount,
      windowStartedAt,
      openUntil,
      now,
    );
    admissionCache.set(cacheKey(platform, endpointScope), {
      database: db,
      expiresAt: now + CLOSED_CACHE_MS,
      row: {
        failure_count: failureCount,
        window_started_at_ms: windowStartedAt,
        open_until_ms: openUntil,
        probe_lease_until_ms: null,
      },
    });
  })();
}

export function recordProviderCircuitSuccess(platform: string, endpointScope = '', now = Date.now()): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM provider_circuit_breakers
    WHERE platform = ? AND endpoint_scope = ?
  `).run(platform, endpointScope);
  admissionCache.set(cacheKey(platform, endpointScope), {
    database: db,
    expiresAt: now + CLOSED_CACHE_MS,
  });
}

export function releaseProviderCircuitProbe(platform: string, endpointScope = '', now = Date.now()): void {
  const db = getDb();
  db.prepare(`
    UPDATE provider_circuit_breakers
    SET probe_lease_until_ms = NULL, updated_at_ms = ?
    WHERE platform = ? AND endpoint_scope = ? AND open_until_ms IS NOT NULL
  `).run(now, platform, endpointScope);
  const key = cacheKey(platform, endpointScope);
  const cached = admissionCache.get(key);
  if (cached?.database === db && cached.row) {
    admissionCache.set(key, {
      database: db,
      expiresAt: now + CLOSED_CACHE_MS,
      row: { ...cached.row, probe_lease_until_ms: null },
    });
  }
}

export function clearProviderCircuitBreakers(): number {
  const deleted = getDb().prepare('DELETE FROM provider_circuit_breakers').run().changes;
  admissionCache.clear();
  return deleted;
}

export function resetProviderCircuitBreakers(): void {
  clearProviderCircuitBreakers();
}
