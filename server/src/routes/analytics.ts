import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M } from '../db/model-pricing.js';

export const analyticsRouter = Router();

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
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      MIN(hour) as first_request_at
    FROM request_hourly
    WHERE hour >= ?
  `).get(aggregateSince) as {
    total_requests: number;
    success_count: number;
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
  const successRate = totalRequests > 0 ? (aggregate.success_count / totalRequests) * 100 : 0;

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

// Stats grouped by model
analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens,
      SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pinned_requests,
      SUM(CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
      ELSE 0 END) as est_cost
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    GROUP BY r.platform, r.model_id
    ORDER BY requests DESC
  `).all(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
    // Requests this model served because the client pinned it by name.
    pinnedRequests: r.pinned_requests ?? 0,
    estimatedCost: Math.round((r.est_cost ?? 0) * 100) / 100,
  })));
});

// Stats grouped by platform
analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      platform,
      COUNT(*) as requests,
      COUNT(latency_ms) as latency_count,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(latency_ms) as avg_latency_ms,
      AVG(ttfb_ms) as avg_ttfb_ms,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      AVG(CASE WHEN output_tokens > 0 AND latency_ms > 0
        THEN output_tokens / (latency_ms / 1000.0) ELSE NULL END) as avg_tokens_per_second,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform
    ORDER BY requests DESC
  `).all(since) as any[];

  // P95 latency is a per-group percentile; SQLite has no native percentile
  // aggregate, so we take the nearest-rank value per platform with a small
  // ORDER BY/OFFSET query. The platform count is tiny (one row per provider),
  // so the extra round-trips are negligible and keep the SQL readable.
  const p95Stmt = db.prepare(`
    SELECT latency_ms FROM requests
    WHERE created_at >= ? AND platform = ? AND latency_ms IS NOT NULL
    ORDER BY latency_ms ASC
    LIMIT 1 OFFSET ?
  `);

  res.json(rows.map(r => {
    // Offset math and the ordered selection both range over the non-null
    // latency rows (latency_count), so a NULL can neither be counted into the
    // denominator nor selected as the p95 value.
    const latencyCount = r.latency_count ?? 0;
    const p95Row = latencyCount > 0
      ? (p95Stmt.get(since, r.platform, Math.floor((latencyCount - 1) * 0.95)) as { latency_ms: number } | undefined)
      : undefined;
    return {
      platform: r.platform,
      requests: r.requests,
      successRate: Math.round(r.success_rate * 10) / 10,
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
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
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
    successRate: Math.round(r.success_rate * 10) / 10,
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

  // Read from request_hourly (hour-bucketed) for both 'hour' and 'day'
  // intervals. Day buckets are rolled up via strftime on the hour column,
  // which keeps the timeline accurate past the raw-row prune window.
  const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', hour) as timestamp,
      SUM(total_requests) as requests,
      SUM(success_count) as success_count,
      SUM(error_count) as failure_count,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens
    FROM request_hourly
    WHERE hour >= ?
    GROUP BY strftime('${dateFormat}', hour)
    ORDER BY timestamp ASC
  `).all(since) as any[];

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

  // Errors by platform
  const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    GROUP BY platform
    ORDER BY count DESC
  `).all(since) as any[];

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

  const rows = db.prepare(`
    SELECT id, platform, model_id, error, latency_ms, created_at
    FROM requests
    WHERE status = 'error' AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(since) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  })));
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
  const db = getDb();

  const total = (db.prepare(
    'SELECT COUNT(*) as c FROM requests WHERE created_at >= ?'
  ).get(since) as { c: number }).c;

  const rows = db.prepare(`
    SELECT id, platform, model_id, requested_model, request_type, status,
           input_tokens, output_tokens, latency_ms, error,
           client_ip, client_user_agent,
           strftime('%Y-%m-%dT%H:%M:%SZ', created_at) as created_at_iso
    FROM requests
    WHERE created_at >= ?
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(since, limit, offset) as any[];

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
      createdAt: r.created_at_iso,
    })),
  });
});
