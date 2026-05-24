// In-memory sliding window rate limit tracker
//
// Counters are kept in RAM for hot-path speed; periodically flushed to
// SQLite so the daily counters (RPD/TPD) and active cooldowns survive
// a process restart. Without persistence, restarting the server at e.g.
// 11pm would silently reset every key's daily quota to zero, causing
// the router to send doomed traffic to upstream providers and learn
// the real quota only via 429 responses.

import type Database from 'better-sqlite3';

interface Window {
  timestamps: number[];
  tokenCount: number;
  tokenTimestamps: { ts: number; tokens: number }[];
}

// Key format: "platform:modelId:keyId:type" where type is rpm|rpd|tpm|tpd
const windows = new Map<string, Window>();

function getWindow(key: string): Window {
  let w = windows.get(key);
  if (!w) {
    w = { timestamps: [], tokenCount: 0, tokenTimestamps: [] };
    windows.set(key, w);
  }
  return w;
}

function pruneTimestamps(timestamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return timestamps.filter(ts => ts > cutoff);
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  if (limits.rpm !== null) {
    const key = `${platform}:${modelId}:${keyId}:rpm`;
    const w = getWindow(key);
    w.timestamps = pruneTimestamps(w.timestamps, MINUTE, now);
    if (w.timestamps.length >= limits.rpm) return false;
  }

  if (limits.rpd !== null) {
    const key = `${platform}:${modelId}:${keyId}:rpd`;
    const w = getWindow(key);
    w.timestamps = pruneTimestamps(w.timestamps, DAY, now);
    if (w.timestamps.length >= limits.rpd) return false;
  }

  return true;
}

export function canUseTokens(
  platform: string,
  modelId: string,
  keyId: number,
  estimatedTokens: number,
  limits: { tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  if (limits.tpm !== null) {
    const key = `${platform}:${modelId}:${keyId}:tpm`;
    const w = getWindow(key);
    w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - MINUTE);
    const used = w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    if (used + estimatedTokens > limits.tpm) return false;
  }

  if (limits.tpd !== null) {
    const key = `${platform}:${modelId}:${keyId}:tpd`;
    const w = getWindow(key);
    w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - DAY);
    const used = w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    if (used + estimatedTokens > limits.tpd) return false;
  }

  return true;
}

export function recordRequest(platform: string, modelId: string, keyId: number) {
  const now = Date.now();

  const rpmKey = `${platform}:${modelId}:${keyId}:rpm`;
  getWindow(rpmKey).timestamps.push(now);

  const rpdKey = `${platform}:${modelId}:${keyId}:rpd`;
  getWindow(rpdKey).timestamps.push(now);
}

export function recordTokens(
  platform: string,
  modelId: string,
  keyId: number,
  tokens: number,
) {
  const now = Date.now();

  const tpmKey = `${platform}:${modelId}:${keyId}:tpm`;
  getWindow(tpmKey).tokenTimestamps.push({ ts: now, tokens });

  const tpdKey = `${platform}:${modelId}:${keyId}:tpd`;
  getWindow(tpdKey).tokenTimestamps.push({ ts: now, tokens });
}

// Cooldown: when a provider returns 429, block that model+key for a period
const cooldowns = new Map<string, number>(); // key -> expiry timestamp

export function setCooldown(platform: string, modelId: string, keyId: number, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  cooldowns.set(key, Date.now() + durationMs);
}

export function isOnCooldown(platform: string, modelId: string, keyId: number): boolean {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

export function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  const rpmW = getWindow(`${platform}:${modelId}:${keyId}:rpm`);
  rpmW.timestamps = pruneTimestamps(rpmW.timestamps, MINUTE, now);

  const rpdW = getWindow(`${platform}:${modelId}:${keyId}:rpd`);
  rpdW.timestamps = pruneTimestamps(rpdW.timestamps, DAY, now);

  const tpmW = getWindow(`${platform}:${modelId}:${keyId}:tpm`);
  tpmW.tokenTimestamps = tpmW.tokenTimestamps.filter(t => t.ts > now - MINUTE);
  const tpmUsed = tpmW.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);

  return {
    rpm: { used: rpmW.timestamps.length, limit: limits.rpm },
    rpd: { used: rpdW.timestamps.length, limit: limits.rpd },
    tpm: { used: tpmUsed, limit: limits.tpm },
  };
}

// ── Persistence ──────────────────────────────────────────────────────────
// Strategy: load all non-stale rows on startup (anything written within the
// last DAY is potentially relevant for the RPD/TPD windows), then flush
// every FLUSH_INTERVAL_MS and again on graceful shutdown. RPM/TPM windows
// are 60s — even a slow flush captures them well enough that a restart
// only loses sub-second-scale precision.

const FLUSH_INTERVAL_MS = 30_000;
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Restore in-memory windows + cooldowns from the rate_limit_state table.
 * Stale rows (older than DAY) are ignored — RPD/TPD windows can't include
 * timestamps that old, so a row whose entries are all expired wouldn't
 * affect any decision anyway.
 */
export function loadRateLimitState(db: Database.Database): void {
  const now = Date.now();
  const cutoff = now - DAY;

  const rows = db.prepare(
    'SELECT key, data FROM rate_limit_state WHERE updated_at > ?'
  ).all(cutoff) as { key: string; data: string }[];

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue; // skip corrupted rows rather than crash startup
    }

    if (row.key.endsWith(':cooldown')) {
      const expiry = (parsed as { expiry?: number }).expiry;
      if (typeof expiry === 'number' && expiry > now) {
        cooldowns.set(row.key, expiry);
      }
    } else if (row.key.endsWith(':rpm') || row.key.endsWith(':rpd')) {
      const ts = (parsed as { timestamps?: number[] }).timestamps ?? [];
      const windowMs = row.key.endsWith(':rpm') ? MINUTE : DAY;
      const fresh = ts.filter(t => t > now - windowMs);
      if (fresh.length > 0) {
        const w = getWindow(row.key);
        w.timestamps = fresh;
      }
    } else if (row.key.endsWith(':tpm') || row.key.endsWith(':tpd')) {
      const tts = (parsed as { tokenTimestamps?: { ts: number; tokens: number }[] }).tokenTimestamps ?? [];
      const windowMs = row.key.endsWith(':tpm') ? MINUTE : DAY;
      const fresh = tts.filter(t => t.ts > now - windowMs);
      if (fresh.length > 0) {
        const w = getWindow(row.key);
        w.tokenTimestamps = fresh;
      }
    }
  }
}

/**
 * Write current in-memory windows + cooldowns to SQLite. Called periodically
 * and on graceful shutdown. Prunes expired entries before writing so the
 * table doesn't grow unbounded. Rows whose data has gone empty after
 * pruning are deleted entirely.
 */
export function flushRateLimitState(db: Database.Database): void {
  const now = Date.now();

  const upsert = db.prepare(`
    INSERT INTO rate_limit_state (key, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `);
  const del = db.prepare('DELETE FROM rate_limit_state WHERE key = ?');

  const apply = db.transaction(() => {
    // Windows
    for (const [key, w] of windows) {
      const isRpm = key.endsWith(':rpm');
      const isRpd = key.endsWith(':rpd');
      const isTpm = key.endsWith(':tpm');
      const isTpd = key.endsWith(':tpd');
      if (!isRpm && !isRpd && !isTpm && !isTpd) continue;

      const windowMs = (isRpm || isTpm) ? MINUTE : DAY;
      let payload: string | null = null;

      if (isRpm || isRpd) {
        const fresh = w.timestamps.filter(t => t > now - windowMs);
        w.timestamps = fresh;
        if (fresh.length > 0) payload = JSON.stringify({ timestamps: fresh });
      } else {
        const fresh = w.tokenTimestamps.filter(t => t.ts > now - windowMs);
        w.tokenTimestamps = fresh;
        if (fresh.length > 0) payload = JSON.stringify({ tokenTimestamps: fresh });
      }

      if (payload) upsert.run(key, payload, now);
      else del.run(key);
    }

    // Cooldowns
    for (const [key, expiry] of cooldowns) {
      if (expiry > now) {
        upsert.run(key, JSON.stringify({ expiry }), now);
      } else {
        cooldowns.delete(key);
        del.run(key);
      }
    }

    // Drop ancient rows for keys we no longer carry in memory.
    db.prepare('DELETE FROM rate_limit_state WHERE updated_at < ?').run(now - DAY);
  });
  apply();
}

/**
 * Start the periodic flush. Call once after initDb() during server startup.
 * Returns a stop fn to be invoked from shutdown hooks; the stop fn does a
 * final synchronous flush before clearing the timer.
 */
export function startRateLimitPersistence(db: Database.Database): () => void {
  loadRateLimitState(db);

  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    try {
      flushRateLimitState(db);
    } catch (err) {
      console.error('[ratelimit] flush failed:', err);
    }
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive just for this timer.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();

  return () => {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    try {
      flushRateLimitState(db);
    } catch (err) {
      console.error('[ratelimit] final flush failed:', err);
    }
  };
}

/**
 * Test helper: wipe in-memory state. Production code should not call this.
 */
export function _resetForTests(): void {
  windows.clear();
  cooldowns.clear();
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
