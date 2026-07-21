// Sliding window rate limit tracker with SQLite persistence.

import { getDb } from '../db/index.js';

interface Window {
  timestamps: number[];
  tokenCount: number;
  tokenTimestamps: { ts: number; tokens: number }[];
}

// Key format: "platform:modelId:keyId:type" where type is rpm|rpd|tpm|tpd
const windows = new Map<string, Window>();
type RateLimitDb = ReturnType<typeof getDb>;
type UsageKind = 'request' | 'tokens';

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

function withDb<T>(fn: (db: RateLimitDb) => T): T | undefined {
  try {
    return fn(getDb());
  } catch {
    return undefined;
  }
}

function recordUsage(
  platform: string,
  modelId: string,
  keyId: number,
  kind: UsageKind,
  tokens: number,
  now: number,
) {
  withDb(db => {
    db.prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, kind, tokens, now);
    db.prepare('DELETE FROM rate_limit_usage WHERE created_at_ms <= ?').run(now - DAY);
  });
}

function countPersistedRequests(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `).get(platform, modelId, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

function sumPersistedTokens(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
         AND kind = 'tokens'
         AND created_at_ms > ?
    `).get(platform, modelId, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

function memoryRequestCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.timestamps = pruneTimestamps(w.timestamps, windowMs, now);
  return w.timestamps.length;
}

function memoryTokenCount(key: string, windowMs: number, now: number): number {
  const w = getWindow(key);
  w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - windowMs);
  return w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
}

function requestCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number {
  const persisted = countPersistedRequests(platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined) return persisted;
  const type = windowMs === MINUTE ? 'rpm' : 'rpd';
  return memoryRequestCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

function tokenCount(
  platform: string,
  modelId: string,
  keyId: number,
  windowMs: number,
  now: number,
): number {
  const persisted = sumPersistedTokens(platform, modelId, keyId, windowMs, now);
  if (persisted !== undefined) return persisted;
  const type = windowMs === MINUTE ? 'tpm' : 'tpd';
  return memoryTokenCount(`${platform}:${modelId}:${keyId}:${type}`, windowMs, now);
}

export function canMakeRequest(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
): boolean {
  const now = Date.now();

  if (limits.rpm !== null) {
    if (requestCount(platform, modelId, keyId, MINUTE, now) >= limits.rpm) return false;
  }

  if (limits.rpd !== null) {
    if (requestCount(platform, modelId, keyId, DAY, now) >= limits.rpd) return false;
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
    const used = tokenCount(platform, modelId, keyId, MINUTE, now);
    if (used + estimatedTokens > limits.tpm) return false;
  }

  if (limits.tpd !== null) {
    const used = tokenCount(platform, modelId, keyId, DAY, now);
    if (used + estimatedTokens > limits.tpd) return false;
  }

  return true;
}

// ── Provider-wide daily request caps (#162) ──
// Some providers enforce one daily REQUEST quota across the WHOLE account,
// shared by every model — not per model. OpenRouter's free tier is the classic
// case: ~1000 requests/day total (50/day if you've bought <10 credits) no
// matter how many different free models you spread them across. The
// per-(platform,model,key) rpd ledger can't see that, so without a provider-wide
// gate the router happily fires (models × rpd) requests and earns surprise 429s.
//
// Defaults below; override per provider with an env var, e.g.
//   PROVIDER_DAILY_REQUEST_CAP_OPENROUTER=50   (set 0 to disable the cap)
const DEFAULT_PROVIDER_DAILY_REQUEST_CAPS: Record<string, number> = {
  openrouter: 1000,
};

const DEFAULT_PROVIDER_DAILY_TOKEN_CAPS: Record<string, number> = {
  // NavyAI's free plan is one shared 150K-token/day pool per key. Individual
  // models carry token_multiplier values, so the provider-visible drain can be
  // higher than the OpenAI usage.total_tokens returned by /chat/completions.
  navy: 150_000,
};

export function getProviderDailyRequestCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_DAILY_REQUEST_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  return DEFAULT_PROVIDER_DAILY_REQUEST_CAPS[platform] ?? null;
}

export function getProviderDailyTokenCap(platform: string): number | null {
  const raw = process.env[`PROVIDER_DAILY_TOKEN_CAP_${platform.toUpperCase()}`];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n === 0 ? null : n;
  }
  return DEFAULT_PROVIDER_DAILY_TOKEN_CAPS[platform] ?? null;
}

function countPersistedProviderRequests(
  platform: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT COUNT(*) AS used
        FROM rate_limit_usage
       WHERE platform = ?
         AND key_id = ?
         AND kind = 'request'
         AND created_at_ms > ?
    `).get(platform, keyId, now - windowMs) as { used: number };
    return row.used;
  });
}

// Total requests today for a provider account+key, summed across every model.
export function providerDailyRequestCount(platform: string, keyId: number, now = Date.now()): number {
  const persisted = countPersistedProviderRequests(platform, keyId, DAY, now);
  if (persisted !== undefined) return persisted;
  // DB-unavailable fallback: sum the per-model rpd windows for this platform+key.
  // Window key format is "platform:modelId:keyId:rpd" (modelId may contain ':').
  let total = 0;
  for (const [key, w] of windows) {
    if (key.startsWith(`${platform}:`) && key.endsWith(`:${keyId}:rpd`)) {
      total += pruneTimestamps(w.timestamps, DAY, now).length;
    }
  }
  return total;
}

// False when this provider account+key has hit its shared daily request cap, so
// the router skips every model on that provider for this key until UTC-ish reset.
export function canUseProvider(platform: string, keyId: number, now = Date.now()): boolean {
  const cap = getProviderDailyRequestCap(platform);
  if (cap === null) return true;
  return providerDailyRequestCount(platform, keyId, now) < cap;
}

type ModelQuotaRow = { tpd_limit: number | null; monthly_token_budget: string | null };

function multiplierFromQuotaRow(row: ModelQuotaRow | undefined, dailyCap: number): number {
  if (!row) return 1;

  const fromLabel = row.monthly_token_budget?.match(/(?:^|[\u00b7(\s])(\d+(?:\.\d+)?)x\b/i);
  if (fromLabel) {
    const n = Number(fromLabel[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const tpd = row.tpd_limit;
  if (tpd != null && tpd > 0 && tpd < dailyCap) return dailyCap / tpd;
  return 1;
}

function getProviderTokenMultiplier(platform: string, modelId: string, dailyCap: number): number {
  if (platform !== 'navy') return 1;
  return withDb(db => {
    const row = db.prepare(`
      SELECT tpd_limit, monthly_token_budget
        FROM models
       WHERE platform = ? AND model_id = ?
       LIMIT 1
    `).get(platform, modelId) as ModelQuotaRow | undefined;
    return multiplierFromQuotaRow(row, dailyCap);
  }) ?? 1;
}

function providerBilledTokens(platform: string, modelId: string, rawTokens: number): number {
  if (rawTokens <= 0) return 0;
  const dailyCap = getProviderDailyTokenCap(platform);
  if (dailyCap === null) return rawTokens;
  const multiplier = getProviderTokenMultiplier(platform, modelId, dailyCap);
  return Math.ceil(rawTokens * multiplier);
}

function sumPersistedProviderTokens(
  platform: string,
  keyId: number,
  windowMs: number,
  now: number,
): number | undefined {
  const dailyCap = getProviderDailyTokenCap(platform);
  if (dailyCap === null) return 0;

  return withDb(db => {
    const rows = db.prepare(`
      SELECT rlu.model_id, COALESCE(SUM(rlu.tokens), 0) AS used,
             m.tpd_limit, m.monthly_token_budget
        FROM rate_limit_usage rlu
        LEFT JOIN models m ON m.platform = rlu.platform AND m.model_id = rlu.model_id
       WHERE rlu.platform = ?
         AND rlu.key_id = ?
         AND rlu.kind = 'tokens'
         AND rlu.created_at_ms > ?
       GROUP BY rlu.model_id
    `).all(platform, keyId, now - windowMs) as (ModelQuotaRow & { model_id: string; used: number })[];

    return rows.reduce((sum, row) => {
      const multiplier = platform === 'navy' ? multiplierFromQuotaRow(row, dailyCap) : 1;
      return sum + Math.ceil(row.used * multiplier);
    }, 0);
  });
}

export function providerDailyTokenCount(platform: string, keyId: number, now = Date.now()): number {
  const persisted = sumPersistedProviderTokens(platform, keyId, DAY, now);
  if (persisted !== undefined) return persisted;

  let total = 0;
  const suffix = `:${keyId}:tpd`;
  for (const [key, w] of windows) {
    if (!key.startsWith(`${platform}:`) || !key.endsWith(suffix)) continue;
    const modelId = key.slice(platform.length + 1, -suffix.length);
    w.tokenTimestamps = w.tokenTimestamps.filter(t => t.ts > now - DAY);
    const raw = w.tokenTimestamps.reduce((sum, t) => sum + t.tokens, 0);
    total += providerBilledTokens(platform, modelId, raw);
  }
  return total;
}

export function canUseProviderTokens(
  platform: string,
  keyId: number,
  modelId: string,
  estimatedTokens: number,
  now = Date.now(),
): boolean {
  const cap = getProviderDailyTokenCap(platform);
  if (cap === null) return true;
  const used = providerDailyTokenCount(platform, keyId, now);
  return used + providerBilledTokens(platform, modelId, estimatedTokens) <= cap;
}

export function recordRequest(platform: string, modelId: string, keyId: number) {
  const now = Date.now();

  const rpmKey = `${platform}:${modelId}:${keyId}:rpm`;
  getWindow(rpmKey).timestamps.push(now);

  const rpdKey = `${platform}:${modelId}:${keyId}:rpd`;
  getWindow(rpdKey).timestamps.push(now);

  recordUsage(platform, modelId, keyId, 'request', 0, now);
  clearNullLimitHits(platform, modelId, keyId);
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

  recordUsage(platform, modelId, keyId, 'tokens', tokens, now);
}

// Cooldown: when a provider returns 429, block that model+key for a period
const cooldowns = new Map<string, number>(); // key -> expiry timestamp

// Escalating cooldown: track hits per key over a rolling 24h window so a
// daily-quota exhaustion (OpenRouter free: 50/day, Cohere free: 33/day, etc.)
// quarantines the key for the rest of the day instead of looping through
// the 2-minute cooldown 20 times per request and consuming every fallback slot.
// In-memory only — state resets on restart, which is fine (a clean restart
// will re-escalate on the next 429 if the quota is genuinely exhausted).
const cooldownHits = new Map<string, number[]>(); // key -> timestamps of recent cooldown set events
const HOUR = 60 * MINUTE;
const COOLDOWN_DURATIONS = [
  2 * MINUTE,   // 1st hit in 24h
  10 * MINUTE,  // 2nd
  HOUR,         // 3rd
  DAY,          // 4th and beyond
];

export function getNextCooldownDuration(platform: string, modelId: string, keyId: number): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const now = Date.now();
  const hits = (cooldownHits.get(key) ?? []).filter(t => t > now - DAY);
  hits.push(now);
  cooldownHits.set(key, hits);
  const idx = Math.min(hits.length - 1, COOLDOWN_DURATIONS.length - 1);
  return COOLDOWN_DURATIONS[idx]!;
}

// Short cooldown for a transient (per-minute) 429 — recovers within ~one window.
const TRANSIENT_COOLDOWN_MS = 90 * 1000;

// Long cooldown for a 402 Payment Required (provider/key out of credits). Unlike
// a 429, this won't clear on the next minute/day window — it needs a top-up or
// billing reset. Bench the model+key for a full day so the router fails over to
// other providers instead of re-hammering a dead key every retry. Re-escalates
// on the next 402 after expiry if still unpaid; a restart re-benches on first hit.
export const PAYMENT_REQUIRED_COOLDOWN_MS = DAY;

// Long cooldown for a 403 Forbidden on a key that already passed validateKey
// (so it is not a dead key — the health checker disables those). A request-time
// 403 means this key's tier can't reach this specific model (e.g. gpt-4o on
// GitHub Models' free tier, subscription-only models on Cloudflare). That won't
// change within a minute window, so bench this model+key for a full day and let
// the router fail over to a model the key can actually serve. See issue #256.
export const MODEL_FORBIDDEN_COOLDOWN_MS = DAY;

// When RPD/TPD limits are NULL (provider's published daily quota is unknown or
// not yet seeded — common for ollama, cloudflare, nvidia, huggingface, mistral,
// kilo, llm7, pollinations), we cannot check a counter against a cap. Fall back
// to a hit-count heuristic: after 2+ 429s within this rolling window, treat as
// "effectively daily-exhausted" and enter the standard escalation ladder at
// the same step the documented-RPD path would. Without this, these providers
// stay stuck at TRANSIENT_COOLDOWN_MS forever even when every request is a
// 429 (observed in production: ollama 130× 429s in 1h with all 90s cooldowns
// expired before the next request). Cheaper than waiting for the operator to
// seed per-provider limits (Option A), still reversible — a successful call
// clears the hit window via the normal path.
//
// Separate counter from `cooldownHits` (used by getNextCooldownDuration's
// escalation ladder). The shared Map would make this state path-coupled to
// the ladder index, which would over-skip steps because the ladder also
// pushes a hit on each call.
const NULL_LIMIT_HIT_THRESHOLD = 2;
const NULL_LIMIT_HIT_WINDOW_MS = HOUR;
const nullLimitHits = new Map<string, number[]>(); // key -> timestamps

function recordNullLimitHit(platform: string, modelId: string, keyId: number, now: number): void {
  const key = `${platform}:${modelId}:${keyId}`;
  const hits = nullLimitHits.get(key) ?? [];
  hits.push(now);
  nullLimitHits.set(key, hits);
}

function clearNullLimitHits(platform: string, modelId: string, keyId: number): void {
  nullLimitHits.delete(`${platform}:${modelId}:${keyId}`);
}

export function recentHitCount(
  platform: string,
  modelId: string,
  keyId: number,
  now: number,
  windowMs: number = NULL_LIMIT_HIT_WINDOW_MS,
): number {
  const key = `${platform}:${modelId}:${keyId}`;
  const hits = nullLimitHits.get(key) ?? [];
  return hits.filter(t => t > now - windowMs).length;
}

// Decide how long to bench a model+key after an upstream 429. Escalate to the
// long quarantine (getNextCooldownDuration, up to 24h) when the model is at its
// DAILY limit (RPD/TPD counter ≥ cap), OR — when limits are unknown — when
// recentHitCount crosses the heuristic threshold. Either way, a long bench
// avoids hammering a truly-dead key.
//
// A transient RPM/TPM 429 with healthy daily counters gets a short fixed
// cooldown and does NOT count toward escalation. This is the common case for
// providers with a tight per-minute token budget but a large daily quota —
// e.g. groq gpt-oss-120b has rpd=1000 yet tpm=8000, so a single burst of large
// prompts 429s on TPM while the daily quota is barely touched. Daily counters
// are persisted (countPersistedRequests / sumPersistedTokens), so this verdict
// is stable across restarts.
export function getCooldownDurationForLimit(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpd: number | null; tpd: number | null },
  retryAfterMs?: number | null,
): number {
  const now = Date.now();
  const rpdExhausted =
    limits.rpd !== null && requestCount(platform, modelId, keyId, DAY, now) >= limits.rpd;
  const tpdExhausted =
    limits.tpd !== null && tokenCount(platform, modelId, keyId, DAY, now) >= limits.tpd;
  // No daily quota published → use repeated-429 heuristic: 2+ 429s in the
  // last hour is treated as effectively daily-exhausted. This unsticks
  // providers that publish no daily cap (ollama, cloudflare, etc.) from the
  // 90s-cooldown-loop without requiring operator-side limit seeding.
  const unknownLimits = limits.rpd === null && limits.tpd === null;
  let heuristicallyExhausted = false;
  if (unknownLimits) {
    // The current hit is recorded first so the threshold can be reached across
    // consecutive 429s, but only for providers where counters cannot decide.
    recordNullLimitHit(platform, modelId, keyId, now);
    heuristicallyExhausted =
      recentHitCount(platform, modelId, keyId, now) >= NULL_LIMIT_HIT_THRESHOLD;
  }
  const base = (rpdExhausted || tpdExhausted || heuristicallyExhausted)
    ? getNextCooldownDuration(platform, modelId, keyId)
    : TRANSIENT_COOLDOWN_MS;
  // Honor an upstream Retry-After as a floor: never bench shorter than our own
  // heuristic, but extend (capped at a day) when the provider explicitly asks
  // to wait longer than we otherwise would.
  if (retryAfterMs != null && retryAfterMs > base) return Math.min(retryAfterMs, DAY);
  return base;
}

function persistedCooldownExpiry(
  platform: string,
  modelId: string,
  keyId: number,
): number | null | undefined {
  return withDb(db => {
    const row = db.prepare(`
      SELECT expires_at_ms
        FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `).get(platform, modelId, keyId) as { expires_at_ms: number } | undefined;
    return row?.expires_at_ms ?? null;
  });
}

function persistCooldown(platform: string, modelId: string, keyId: number, expiresAtMs: number) {
  withDb(db => {
    db.prepare(`
      INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, model_id, key_id)
      DO UPDATE SET expires_at_ms = excluded.expires_at_ms
    `).run(platform, modelId, keyId, expiresAtMs);
  });
}

function clearPersistedCooldown(platform: string, modelId: string, keyId: number) {
  withDb(db => {
    db.prepare(`
      DELETE FROM rate_limit_cooldowns
       WHERE platform = ?
         AND model_id = ?
         AND key_id = ?
    `).run(platform, modelId, keyId);
  });
}

export function setCooldown(platform: string, modelId: string, keyId: number, durationMs = 60_000) {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const expiresAtMs = Date.now() + durationMs;
  cooldowns.set(key, expiresAtMs);
  persistCooldown(platform, modelId, keyId, expiresAtMs);
}

export function isOnCooldown(platform: string, modelId: string, keyId: number): boolean {
  const key = `${platform}:${modelId}:${keyId}:cooldown`;
  const now = Date.now();
  const persistedExpiry = persistedCooldownExpiry(platform, modelId, keyId);
  if (persistedExpiry !== undefined && persistedExpiry !== null) {
    if (now > persistedExpiry) {
      cooldowns.delete(key);
      clearPersistedCooldown(platform, modelId, keyId);
      return false;
    }
    cooldowns.set(key, persistedExpiry);
    return true;
  }

  const expiry = cooldowns.get(key);
  if (!expiry) return false;
  if (now > expiry) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

/**
 * Soonest moment any active cooldown expires, in ms since epoch, or null when
 * nothing is cooling down. Used to tell an exhausted caller roughly when to
 * retry (#423) instead of the bare "wait for rate limits to reset".
 */
export function getSoonestCooldownExpiry(now = Date.now()): number | null {
  return withDb(db => {
    const row = db.prepare(`
      SELECT MIN(expires_at_ms) AS soonest
        FROM rate_limit_cooldowns
       WHERE expires_at_ms > ?
    `).get(now) as { soonest: number | null } | undefined;
    return row?.soonest ?? null;
  }) ?? null;
}

export function getRateLimitStatus(
  platform: string,
  modelId: string,
  keyId: number,
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null },
) {
  const now = Date.now();

  return {
    rpm: { used: requestCount(platform, modelId, keyId, MINUTE, now), limit: limits.rpm },
    rpd: { used: requestCount(platform, modelId, keyId, DAY, now), limit: limits.rpd },
    tpm: { used: tokenCount(platform, modelId, keyId, MINUTE, now), limit: limits.tpm },
  };
}

// ── Learning real provider limits from error bodies (self-correcting catalog) ──
// Free-tier limits drift and our seeded catalog is frequently wrong or null.
// When a provider rejects a request with its real limit in the body — Groq 413:
// "...on tokens per minute (TPM): Limit 30000, Requested 33476" — we can learn
// that ceiling and persist it so the canUseTokens / canMakeRequest pre-checks
// stop us BEFORE the next 413 instead of re-discovering it on every request.
// (Fork-validated: andersmmg's updateLimitsFromError parses the same Groq shape.)

export type LearnedLimitKind = 'tpm' | 'tpd' | 'rpm' | 'rpd';
export interface LearnedLimit { kind: LearnedLimitKind; limit: number; }

// Order matters: check the per-DAY axes before per-MINUTE so "tokens per day"
// isn't shadowed by the "tpm" word-boundary alternative, and tokens before
// requests so a body mentioning both lands on the more specific token ceiling.
const LIMIT_AXIS_PATTERNS: Array<{ kind: LearnedLimitKind; re: RegExp }> = [
  { kind: 'tpd', re: /tokens?\s*per\s*day|\btpd\b/i },
  { kind: 'tpm', re: /tokens?\s*per\s*min(?:ute)?|\btpm\b/i },
  { kind: 'rpd', re: /requests?\s*per\s*day|\brpd\b/i },
  { kind: 'rpm', re: /requests?\s*per\s*min(?:ute)?|\brpm\b/i },
];

/**
 * Pure parser: pull a provider-reported ceiling out of an error message. Returns
 * null unless BOTH a numeric "Limit N" and a confident axis (TPM/TPD/RPM/RPD)
 * are present — guessing the axis would write the wrong column and mis-route
 * every future request, so we refuse to guess.
 */
export function parseProviderLimit(message: string | undefined | null): LearnedLimit | null {
  if (!message) return null;
  const m = message.match(/\blimit[:\s]+([\d,]+)/i);
  if (!m) return null;
  const limit = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  for (const { kind, re } of LIMIT_AXIS_PATTERNS) {
    if (re.test(message)) return { kind, limit };
  }
  return null;
}

// Whitelisted column names — the only values ever interpolated into the UPDATE
// below, so there is no injection surface despite the template literal.
const LIMIT_COLUMN: Record<LearnedLimitKind, string> = {
  tpm: 'tpm_limit', tpd: 'tpd_limit', rpm: 'rpm_limit', rpd: 'rpd_limit',
};

/**
 * Persist a provider-reported limit onto the model row, but ONLY when it makes
 * us more conservative: fill a NULL (unknown) limit, or LOWER an existing one
 * that was too high. Never raises a limit — hitting a ceiling means our pre-check
 * already let too much through, so the true limit is at or below what we used.
 * Returns the learned limit when a row was actually changed, else null.
 * DB-guarded (no-op when the DB is unavailable), like the rest of this module.
 */
export function learnLimitFromError(modelDbId: number, err: { message?: string }): LearnedLimit | null {
  const parsed = parseProviderLimit(err?.message);
  if (!parsed) return null;
  const col = LIMIT_COLUMN[parsed.kind];
  const result = withDb(db =>
    db.prepare(
      `UPDATE models SET ${col} = ? WHERE id = ? AND (${col} IS NULL OR ${col} > ?)`,
    ).run(parsed.limit, modelDbId, parsed.limit),
  );
  return result && result.changes > 0 ? parsed : null;
}
