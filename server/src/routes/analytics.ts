import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M } from '../db/model-pricing.js';
import { providerIdFor, providerDisplayName } from '../lib/provider-identity.js';
import { normalizeBaseUrl } from '../lib/endpoint-scope.js';

export const analyticsRouter = Router();

// The endpoint identity of a request, in SQL: the serving key's base_url, ''
// when the key is gone or carries none (every catalog key). Custom endpoints
// all share the platform id 'custom' (services/custom-endpoint.ts), so any
// view that groups by `platform` alone collapses every relay into one row and
// the operator cannot tell which endpoint did what (#889) — this expression is
// the second half of the grouping key everywhere that matters.
//
// rtrim/trim mirror lib/endpoint-scope.normalizeBaseUrl so the SQL side agrees
// with the ids providerIdFor() builds: keys.ts normalizes base_url on write,
// but rows stored before it did would otherwise split one endpoint in two.
// Requires the query to LEFT JOIN api_keys as `k`.
const ENDPOINT_ID_SQL = "COALESCE(rtrim(trim(k.base_url), '/'), '')";

// Format UTC timestamps the same way SQLite stores created_at text values.
const toSqliteDateTime = (timestamp: number) =>
    new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');

// Return the rolling cutoff timestamp for the selected analytics range.
function getSinceTimestamp(range: string): string {
  const now = Date.now();

  switch (range) {
    case '24h':
      return toSqliteDateTime(now - 24 * 60 * 60 * 1000);
    case '30d':
      return toSqliteDateTime(now - 30 * 24 * 60 * 60 * 1000);
    case '90d':
      return toSqliteDateTime(now - 90 * 24 * 60 * 60 * 1000);
    case '7d':
    default:
      return toSqliteDateTime(now - 7 * 24 * 60 * 60 * 1000);
  }
}

// Range-based window read from the durable `request_hourly` aggregate. The raw
// `requests` table is pruned by REQUEST_ANALYTICS_MAX_ROWS, so any analytics
// count that depends on a >=7d window must read from the hourly table to stay
// accurate. Hourly resolution is fine for any UI range the dashboard exposes.
function readAggregateSince(since: string) {
  const db = getDb();
  // Hour keys are created_at truncated to the hour, so they share SQLite's
  // canonical 'YYYY-MM-DD HH:00:00' text (space separator). The range cutoff is
  // already in that format — floor it to the hour and compare the strings
  // directly. No separator conversion: the writer (logRequest) and the timeline
  // reader both compare on the space form, so this must too.
  const aggregateSince = since.slice(0, 13) + ':00:00';
  const rows = db.prepare(`
    SELECT
      COALESCE(SUM(total_requests), 0) as total_requests,
      COALESCE(SUM(success_count), 0) as success_count,
      COALESCE(SUM(error_count), 0) as error_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      MIN(hour) as first_request_at
    FROM request_hourly
    WHERE hour >= ?
  `).get(aggregateSince) as {
    total_requests: number;
    success_count: number;
    error_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    first_request_at: string | null;
  };
  return rows;
}

function readLifetimeSettings() {
  const db = getDb();
  const row = db.prepare(`
    SELECT value FROM settings WHERE key = 'first_request_at'
  `).get() as { value: string } | undefined;
  return row?.value ?? null;
}

// Summary stats
analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  // Totals (request count, token sums, success rate, lifetime first_request_at)
  // come from the durable `request_hourly` aggregate so they stay accurate even
  // after the raw `requests` table is pruned. Per-model pin-honor rate and
  // estimated savings still need the raw table because they're broken down by
  // (platform, model_id); for those we fall back to the raw rows but they're
  // only reported for ranges where recent activity still exists. The aggregate
  // is the source of truth for headline numbers.
  const aggregate = readAggregateSince(since);
  const totalRequests = aggregate.total_requests ?? 0;
  // Success rate over success+error only: a 'canceled' request (#752 — client
  // hung up) still counts in the totals but is neither a success nor a
  // failure, so it must not dilute the rate.
  const decidedRequests = (aggregate.success_count ?? 0) + (aggregate.error_count ?? 0);
  const successRate = decidedRequests > 0 ? (aggregate.success_count / decidedRequests) * 100 : 0;

  // Avg latency is only meaningful at the raw row level; the hourly bucket
  // doesn't preserve it. Fall back to a 0/null when no recent raw rows exist.
  const latencyRow = db.prepare(`
    SELECT AVG(latency_ms) as avg_latency_ms FROM requests WHERE created_at >= ?
  `).get(since) as { avg_latency_ms: number | null } | undefined;

  // Estimated savings is a per-request priced value, so it lives on the raw
  // rows. For ranges where the raw table is empty we report 0 (no recent
  // activity to price).
  const savings = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
      ELSE 0 END
    ), 0) as est_savings
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
  `).get(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since) as { est_savings: number };

  // Pin-honor stats are also raw-row scoped. We still report them when present
  // (typically 24h/7d) and gracefully drop them when the raw window is empty.
  const pinRow = db.prepare(`
    SELECT
      SUM(CASE WHEN requested_model IS NOT NULL THEN 1 ELSE 0 END) as pinned_count,
      SUM(CASE WHEN requested_model = model_id THEN 1 ELSE 0 END) as pin_honored_count
    FROM requests WHERE created_at >= ?
  `).get(since) as { pinned_count: number | null; pin_honored_count: number | null };

  // Latency percentiles, time-to-first-token, and the chat/embedding split all
  // live on the raw rows (the hourly aggregate keeps neither latency nor a
  // per-type breakdown). When the raw window is empty (older than the prune
  // horizon) we report null, not 0, so the UI can render a placeholder instead
  // of a misleading zero. Percentiles use nearest-rank via ORDER BY/OFFSET.
  // Only rows that actually recorded a latency participate in the percentile.
  // The IS NOT NULL guard must be on BOTH the offset-denominator count and the
  // ordered selection so they range over the same set: a NULL sorts first under
  // ORDER BY latency_ms ASC, so if it were counted but not filtered the offset
  // math would shift and a NULL could be selected (rendered as 0).
  const rawCount = (db.prepare(
    `SELECT COUNT(*) as c FROM requests WHERE created_at >= ? AND latency_ms IS NOT NULL`
  ).get(since) as { c: number }).c;
  const percentileAt = (fraction: number): number | null => {
    if (rawCount === 0) return null;
    const offset = Math.floor((rawCount - 1) * fraction);
    const row = db.prepare(`
      SELECT latency_ms FROM requests
      WHERE created_at >= ? AND latency_ms IS NOT NULL
      ORDER BY latency_ms ASC
      LIMIT 1 OFFSET ?
    `).get(since, offset) as { latency_ms: number } | undefined;
    return row ? Math.round(row.latency_ms) : null;
  };
  const p50LatencyMs = percentileAt(0.5);
  const p95LatencyMs = percentileAt(0.95);

  const ttfbRow = db.prepare(`
    SELECT AVG(ttfb_ms) as avg_ttfb_ms FROM requests
    WHERE created_at >= ? AND ttfb_ms IS NOT NULL
  `).get(since) as { avg_ttfb_ms: number | null } | undefined;
  const avgTtfbMs = ttfbRow?.avg_ttfb_ms != null ? Math.round(ttfbRow.avg_ttfb_ms) : null;

  const typeRows = db.prepare(`
    SELECT request_type, COUNT(*) as count FROM requests
    WHERE created_at >= ?
    GROUP BY request_type
  `).all(since) as Array<{ request_type: string; count: number }>;
  const requestTypeCounts = { chat: 0, embedding: 0 };
  for (const row of typeRows) {
    if (row.request_type === 'embedding') requestTypeCounts.embedding = row.count;
    else if (row.request_type === 'chat') requestTypeCounts.chat = row.count;
  }

  const lifetimeFirst = readLifetimeSettings();

  res.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: aggregate.total_input_tokens ?? 0,
    totalOutputTokens: aggregate.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(latencyRow?.avg_latency_ms ?? 0),
    // Latency spread (raw rows): p50 typical, p95 tail. Null when the raw
    // window is empty.
    p50LatencyMs,
    p95LatencyMs,
    // Average streaming time-to-first-token over rows that recorded it; null
    // when none did (non-streaming traffic or pruned window).
    avgTtfbMs,
    // Chat vs embedding request split for the selected window.
    requestTypeCounts,
    estimatedCostSavings: Math.round((savings.est_savings ?? 0) * 100) / 100,
    // Pinned = requests where the client named a specific model (not 'auto').
    // Honored = the pinned model actually served it; the difference is
    // failovers that overrode the pin.
    pinnedRequests: pinRow.pinned_count ?? 0,
    pinHonoredRequests: pinRow.pin_honored_count ?? 0,
    // First-ever request timestamp (lifetime, never pruned). Falls back to
    // the oldest hour in the current window when lifetime is not yet seeded.
    firstRequestAt: lifetimeFirst ?? aggregate.first_request_at ?? null,
    // Lifetime total since install — useful when the user wants to see "all
    // time" alongside the selected range window. Sourced from settings so it
    // survives the raw-row prune entirely.
    lifetimeTotalRequests: Number((db.prepare(`SELECT value FROM settings WHERE key='total_requests'`).get() as { value?: string } | undefined)?.value ?? 0) || 0,
  });
});

// Stats grouped by model.
//
// The grouping key is (platform, endpoint, model_id), not (platform, model_id):
// the same model id served by two different custom relays is two different
// things — different latency, different failure modes — and merging them into
// one row labelled "custom" is the #889 collision in its most misleading form,
// because the merged row's numbers describe neither endpoint.
//
// The models join is endpoint-scoped for the same reason. `models` is unique on
// (platform, model_id, endpoint_scope) since #651, so joining on
// (platform, model_id) alone matches ONE row per relay that registered the
// model and multiplies every request row by that count. Adding endpoint_scope
// to the ON clause picks the row belonging to the endpoint that actually served
// the request — the only one whose display name and pricing apply.
analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.platform,
      ${ENDPOINT_ID_SQL} as base_url,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      -- Rate over success+error only: 'canceled' (#752) is neither.
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN r.status <> 'canceled' THEN 1 ELSE 0 END), 0) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens,
      SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pinned_requests,
      SUM(CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
      ELSE 0 END) as est_cost
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    LEFT JOIN models m
      ON m.platform = r.platform AND m.model_id = r.model_id
     AND m.endpoint_scope = ${ENDPOINT_ID_SQL}
    WHERE r.created_at >= ?
    GROUP BY r.platform, ${ENDPOINT_ID_SQL}, r.model_id
    ORDER BY requests DESC
  `).all(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    // Same row identity as /by-platform, so a model row and a provider row for
    // one endpoint carry the same id and the same operator-readable name.
    providerId: providerIdFor(r.platform, r.base_url || null),
    endpoint: providerDisplayName(r.platform, r.base_url || null),
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    // success_rate is NULL when every row in the group was canceled.
    successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
    // Requests this model served because the client pinned it by name.
    pinnedRequests: r.pinned_requests ?? 0,
    estimatedCost: Math.round((r.est_cost ?? 0) * 100) / 100,
  })));
});

// Stats grouped by platform.
//
// Custom endpoints all share the platform id 'custom' (services/custom-
// endpoint.ts), so grouping by `platform` alone would collapse every custom
// relay into one row and the operator could not tell which endpoint did what
// (#889). We therefore also group by the serving key's base_url — the canonical
// endpoint identity (custom-endpoint.ts pools credentials by base_url, and the
// router treats every key sharing a base_url as one endpoint). Non-custom keys
// carry no base_url, so COALESCE(base_url,'') keeps each of them in a single
// per-platform group exactly as before.
analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.platform,
      ${ENDPOINT_ID_SQL} as base_url,
      COUNT(*) as requests,
      COUNT(r.latency_ms) as latency_count,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN r.status <> 'canceled' THEN 1 ELSE 0 END), 0) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      AVG(r.ttfb_ms) as avg_ttfb_ms,
      SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) as error_count,
      AVG(CASE WHEN r.output_tokens > 0 AND r.latency_ms > 0
        THEN r.output_tokens / (r.latency_ms / 1000.0) ELSE NULL END) as avg_tokens_per_second,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?
    GROUP BY r.platform, ${ENDPOINT_ID_SQL}
    ORDER BY requests DESC
  `).all(since) as any[];

  // P95 latency is a per-group percentile; SQLite has no native percentile
  // aggregate, so we take the nearest-rank value per group with a small
  // ORDER BY/OFFSET query. The group count is tiny (one row per provider /
  // custom endpoint), so the extra round-trips are negligible and keep the SQL
  // readable. The WHERE must match the grouping exactly — platform AND the
  // endpoint's base_url — or a custom endpoint's p95 would bleed in latency
  // from every other custom endpoint.
  const p95Stmt = db.prepare(`
    SELECT r.latency_ms FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ? AND r.platform = ? AND ${ENDPOINT_ID_SQL} = ? AND r.latency_ms IS NOT NULL
    ORDER BY r.latency_ms ASC
    LIMIT 1 OFFSET ?
  `);

  res.json(rows.map(r => {
    // Offset math and the ordered selection both range over the non-null
    // latency rows (latency_count), so a NULL can neither be counted into the
    // denominator nor selected as the p95 value.
    const latencyCount = r.latency_count ?? 0;
    const baseUrl: string | null = r.base_url || null;
    const p95Row = latencyCount > 0
      ? (p95Stmt.get(since, r.platform, r.base_url, Math.floor((latencyCount - 1) * 0.95)) as { latency_ms: number } | undefined)
      : undefined;
    return {
      platform: r.platform,
      // Stable, unique id for this row: the platform slug for catalog providers,
      // 'custom:<base_url>' for custom endpoints (falls back to 'custom' when
      // the key is gone). The client uses this as the chart key and the
      // recent-calls filter value.
      providerId: providerIdFor(r.platform, baseUrl),
      // The short identifier the operator actually reads: the endpoint host for
      // custom rows, the platform slug otherwise.
      endpoint: providerDisplayName(r.platform, baseUrl),
      requests: r.requests,
      successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
      avgLatencyMs: Math.round(r.avg_latency_ms),
      p95LatencyMs: p95Row ? Math.round(p95Row.latency_ms) : null,
      avgTtfbMs: r.avg_ttfb_ms != null ? Math.round(r.avg_ttfb_ms) : null,
      errorCount: r.error_count ?? 0,
      avgTokensPerSecond: r.avg_tokens_per_second != null
        ? Math.round(r.avg_tokens_per_second * 10) / 10
        : null,
      totalInputTokens: r.total_input_tokens ?? 0,
      totalOutputTokens: r.total_output_tokens ?? 0,
    };
  }));
});

analyticsRouter.get('/by-client', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const rows = getDb().prepare(`
    SELECT
      COALESCE(client_agent, 'unknown') AS client_agent,
      COUNT(*) AS requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN status <> 'canceled' THEN 1 ELSE 0 END), 0) AS success_rate,
      AVG(latency_ms) AS avg_latency_ms,
      SUM(input_tokens) AS total_input_tokens,
      SUM(output_tokens) AS total_output_tokens,
      MAX(strftime('%Y-%m-%dT%H:%M:%SZ', created_at)) AS last_seen_at
    FROM requests
    WHERE created_at >= ?
    GROUP BY client_agent
    ORDER BY requests DESC
  `).all(since) as any[];

  res.json(rows.map(row => ({
    clientAgent: row.client_agent,
    requests: row.requests,
    successRate: Math.round((row.success_rate ?? 0) * 10) / 10,
    avgLatencyMs: Math.round(row.avg_latency_ms ?? 0),
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    lastSeenAt: row.last_seen_at,
  })));
});

// Stats grouped by API key. Raw-row scoped (the hourly aggregate has no key
// dimension), LEFT JOINed to api_keys so a request whose key was later deleted
// still shows up with a null label — the keyId is always returned.
analyticsRouter.get('/by-key', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.key_id as key_id,
      k.label as label,
      k.platform as platform,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN r.status <> 'canceled' THEN 1 ELSE 0 END), 0) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.key_id IS NOT NULL AND r.created_at >= ?
    GROUP BY r.key_id
    ORDER BY requests DESC
    LIMIT 50
  `).all(since) as any[];

  res.json(rows.map(r => ({
    keyId: r.key_id,
    // Null when the key row was deleted, or the empty string when the key
    // exists but was never labelled; the client falls back to "Key #<id>".
    label: r.label ?? null,
    platform: r.platform ?? null,
    requests: r.requests,
    successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

// Timeline data
analyticsRouter.get('/timeline', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const interval = (req.query.interval as string) ?? (range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);
  const db = getDb();

  // dateFormat is a hardcoded whitelist — never user-controlled.
  const dateFormat = interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  // tzOffset: viewer's local offset from UTC in minutes (480 = UTC+8), sent by
  // the browser so hour/day bucket boundaries follow the viewer's wall clock
  // instead of UTC. Whitelisted to a sane integer range; bound as a parameter,
  // never interpolated into SQL.
  const rawOffset = Number(req.query.tzOffset);
  const tzOffset = Number.isInteger(rawOffset) && rawOffset >= -720 && rawOffset <= 840 ? rawOffset : 0;
  // The single current offset applies to the whole range (SQLite has no tz
  // database), so buckets on the far side of a DST transition sit 1h off.
  const tzModifier = `${tzOffset >= 0 ? '+' : '-'}${Math.abs(tzOffset)} minutes`;

  // Read from request_hourly (hour-bucketed) for both 'hour' and 'day'
  // intervals. Day buckets are rolled up via strftime on the hour column,
  // which keeps the timeline accurate past the raw-row prune window.
  const rows = db.prepare(`
    SELECT
      strftime(?, hour, ?) as timestamp,
      SUM(total_requests) as requests,
      SUM(success_count) as success_count,
      SUM(error_count) as failure_count,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens
    FROM request_hourly
    WHERE hour >= ?
    GROUP BY timestamp
    ORDER BY timestamp ASC
  `).all(dateFormat, tzModifier, since) as any[];

  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    requests: r.requests,
    successCount: r.success_count,
    failureCount: r.failure_count,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
  })));
});

// Error distribution (grouped by error type and platform)
analyticsRouter.get('/error-distribution', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  // Group errors by category (extract the key part of the error message)
  const rows = db.prepare(`
    SELECT
      platform,
      model_id,
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform, error_category
    ORDER BY count DESC
  `).all(since) as any[];

  // Also get totals by category
  const byCategory = db.prepare(`
    SELECT
      CASE
        WHEN error LIKE '%429%' OR error LIKE '%rate limit%' OR error LIKE '%too many%' OR error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN error LIKE '%401%' OR error LIKE '%unauthorized%' OR error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN error LIKE '%403%' OR error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN error LIKE '%404%' OR error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN error LIKE '%timeout%' OR error LIKE '%ETIMEDOUT%' OR error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN error LIKE '%500%' OR error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN error LIKE '%503%' OR error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY category
    ORDER BY count DESC
  `).all(since) as any[];

  // Errors by provider. Endpoint-scoped like /by-platform: one bar per custom
  // relay, not one bar pooling every relay's failures under "custom" (#889) —
  // a bar the operator cannot act on, because it never says which endpoint is
  // the one failing.
  const byPlatformRows = db.prepare(`
    SELECT r.platform, ${ENDPOINT_ID_SQL} as base_url, COUNT(*) as count
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.status = 'error' AND r.created_at >= ?
    GROUP BY r.platform, ${ENDPOINT_ID_SQL}
    ORDER BY count DESC
  `).all(since) as any[];

  const byPlatform = byPlatformRows.map(r => {
    const baseUrl: string | null = r.base_url || null;
    return {
      // `platform` stays the raw slug: it is what the chart colors by.
      platform: r.platform,
      providerId: providerIdFor(r.platform, baseUrl),
      endpoint: providerDisplayName(r.platform, baseUrl),
      count: r.count,
    };
  });

  res.json({
    byCategory,
    byPlatform,
    detailed: rows,
  });
});

// Recent errors
analyticsRouter.get('/errors', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  // Joined to the serving key so each error names the endpoint it came from.
  // Without it every custom relay's failures read as a bare "custom" in the
  // panel (#889) and the operator has to guess which one broke.
  const rows = db.prepare(`
    SELECT r.id, r.platform, ${ENDPOINT_ID_SQL} as base_url, r.model_id, r.error,
           r.latency_ms, r.created_at
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.status = 'error' AND r.created_at >= ?
    ORDER BY r.created_at DESC
    LIMIT 50
  `).all(since) as any[];

  res.json(rows.map(r => {
    const baseUrl: string | null = r.base_url || null;
    return {
      id: r.id,
      platform: r.platform,
      providerId: providerIdFor(r.platform, baseUrl),
      endpoint: providerDisplayName(r.platform, baseUrl),
      modelId: r.model_id,
      error: r.error,
      latencyMs: r.latency_ms,
      createdAt: r.created_at,
    };
  }));
});

// Recent calls — one row per proxied request, newest first, with the caller's
// IP and User-Agent (all local clients share the unified key, so client_ip is
// the only per-caller discriminator; UA disambiguates tunneled loopback calls).
// Reads the raw `requests` table, so history is bounded by the retention prune.
analyticsRouter.get('/requests', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  // Optional filters. All are validated (whitelist / shape) and applied as
  // bound parameters; absent filters keep the default behavior identical.
  const status = req.query.status as string | undefined;
  if (status !== undefined && status !== 'success' && status !== 'error' && status !== 'canceled') {
    res.status(400).json({ error: "invalid status filter (expected 'success', 'error' or 'canceled')" });
    return;
  }
  // Provider filter. The `provider` param carries the stable row id returned by
  // /by-platform: a platform slug ('groq') or 'custom:<base_url>' for a custom
  // endpoint (#889 — every custom relay shares the 'custom' platform id, so the
  // endpoint's base_url is what actually selects one). The legacy `platform`
  // param still works for old clients. Both are bound parameters, never
  // interpolated, so the only validation needed is shape.
  const provider = req.query.provider as string | undefined;
  const platform = req.query.platform as string | undefined;
  let providerFilterSql = '';
  const providerFilterParams: string[] = [];
  if (provider !== undefined) {
    if (provider.length > 256 || /[\r\n]/.test(provider)) {
      res.status(400).json({ error: 'invalid provider filter' });
      return;
    }
    if (provider === 'custom') {
      // The BARE 'custom' id is the orphan bucket, not "all custom traffic":
      // /by-platform emits it only for rows whose endpoint is unknown (the key
      // was deleted, or never carried a base_url). Falling through to the slug
      // branch below would filter on `platform = 'custom'` and return every
      // relay's traffic — a list that contradicts the very row the user
      // clicked, which counted the orphans alone. Match what that row counted.
      providerFilterSql = ` AND r.platform = 'custom' AND ${ENDPOINT_ID_SQL} = ''`;
    } else if (provider.startsWith('custom:')) {
      // Select one custom endpoint by its base_url. Normalized on the way in
      // for the same reason ENDPOINT_ID_SQL normalizes on the way out.
      providerFilterSql = ` AND r.platform = 'custom' AND ${ENDPOINT_ID_SQL} = ?`;
      providerFilterParams.push(normalizeBaseUrl(provider.slice('custom:'.length)));
    } else if (/^[A-Za-z0-9_-]{1,64}$/.test(provider)) {
      providerFilterSql = ' AND r.platform = ?';
      providerFilterParams.push(provider);
    } else {
      res.status(400).json({ error: 'invalid provider filter' });
      return;
    }
  } else if (platform !== undefined) {
    // The legacy param keeps its pre-#889 meaning: `platform=custom` is every
    // custom relay's traffic. Only the `provider` ids are endpoint-scoped.
    // Platform ids are short slugs ('groq', 'pt-custom_1'); anything else is a
    // client bug, not a filter.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(platform)) {
      res.status(400).json({ error: 'invalid platform filter' });
      return;
    }
    providerFilterSql = ' AND r.platform = ?';
    providerFilterParams.push(platform);
  }
  const db = getDb();

  const filterSql =
    (status !== undefined ? ' AND r.status = ?' : '') +
    providerFilterSql;
  const filterParams = [
    ...(status !== undefined ? [status] : []),
    ...providerFilterParams,
  ];

  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM requests r
       LEFT JOIN api_keys k ON k.id = r.key_id
      WHERE r.created_at >= ?${filterSql}`
  ).get(since, ...filterParams) as { c: number }).c;

  const rows = db.prepare(`
    SELECT r.id, r.platform, r.model_id, r.requested_model, r.request_type, r.status,
           r.input_tokens, r.output_tokens, r.latency_ms, r.error,
           r.client_ip, r.client_user_agent, r.client_agent,
           strftime('%Y-%m-%dT%H:%M:%SZ', r.created_at) as created_at_iso,
           (SELECT COUNT(*) FROM request_attempts a WHERE a.request_id = r.id) as attempt_count,
           k.label as key_label
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${filterSql}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(since, ...filterParams, limit, offset) as any[];

  res.json({
    total,
    rows: rows.map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      requestedModel: r.requested_model,
      requestType: r.request_type,
      status: r.status,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      latencyMs: r.latency_ms,
      error: r.error,
      clientIp: r.client_ip,
      clientUserAgent: r.client_user_agent,
      clientAgent: r.client_agent,
      createdAt: r.created_at_iso,
      // #785: custom endpoints all share the generic 'custom' platform id, so
      // the user's key label ("Ollama box") rides along to name the real
      // provider in the recent-calls list. Null when the key was deleted or
      // never labelled.
      keyLabel: r.key_label ?? null,
      // Failover-ladder length for this row. Attempts hang off the TERMINAL
      // row of a proxied request; mid-ladder failure rows report 0.
      attemptCount: r.attempt_count,
    })),
  });
});

// Per-request detail: the row plus its durable failover ladder — one entry per
// dispatched attempt (including the successful final one), ordinal-ordered,
// with the failure class and timing of each hop. keyOrdinal is the per-request
// key ordinal (key1, key2…), same anonymization as X-Fallback-Trail — internal
// key ids are never exposed. Attempts are keyed to the ladder's terminal row
// (the success row, or the last failure row when it exhausted), so mid-ladder
// error rows legitimately return an empty attempts array.
analyticsRouter.get('/requests/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid request id' });
    return;
  }
  const db = getDb();

  const r = db.prepare(`
    SELECT id, platform, model_id, requested_model, served_model, request_type, status,
           input_tokens, output_tokens, latency_ms, ttfb_ms, error,
           client_ip, client_user_agent, client_agent,
           strftime('%Y-%m-%dT%H:%M:%SZ', created_at) as created_at_iso
    FROM requests
    WHERE id = ?
  `).get(id) as any;
  if (!r) {
    res.status(404).json({ error: 'request not found' });
    return;
  }

  const attempts = db.prepare(`
    SELECT ordinal, platform, model_id, key_ordinal, key_label, outcome, start_offset_ms, duration_ms, error_summary
    FROM request_attempts
    WHERE request_id = ?
    ORDER BY ordinal ASC
  `).all(id) as any[];

  res.json({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    requestedModel: r.requested_model,
    // Upstream-reported model when it genuinely differed from the routed
    // model_id (#534 served-model drift guard); null in the healthy case.
    servedModel: r.served_model,
    requestType: r.request_type,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    latencyMs: r.latency_ms,
    ttfbMs: r.ttfb_ms,
    error: r.error,
    clientIp: r.client_ip,
    clientUserAgent: r.client_user_agent,
    clientAgent: r.client_agent,
    createdAt: r.created_at_iso,
    attempts: attempts.map(a => ({
      ordinal: a.ordinal,
      platform: a.platform,
      modelId: a.model_id,
      keyOrdinal: a.key_ordinal,
      keyLabel: a.key_label ?? null,
      outcome: a.outcome,
      startOffsetMs: a.start_offset_ms,
      durationMs: a.duration_ms,
      // Short, redacted per-hop error text (null for successful hops and for
      // rows written before the error_summary migration).
      errorSummary: a.error_summary ?? null,
    })),
  });
});
