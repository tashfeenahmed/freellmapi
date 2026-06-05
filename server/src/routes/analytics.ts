import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';

export const analyticsRouter = Router();

// Format UTC timestamps the same way SQLite stores created_at text values.
const toSqliteDateTime = (timestamp: number) =>
  new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');

// Return the rolling cutoff timestamp for the selected analytics range.
function getSinceTimestamp(range: string): string {
  const now = Date.now();

  switch (range) {
    case '1h':
      return toSqliteDateTime(now - 60 * 60 * 1000);
    case '24h':
      return toSqliteDateTime(now - 24 * 60 * 60 * 1000);
    case '30d':
      return toSqliteDateTime(now - 30 * 24 * 60 * 60 * 1000);
    case '7d':
    default:
      return toSqliteDateTime(now - 7 * 24 * 60 * 60 * 1000);
  }
}

// Summary stats
analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      AVG(latency_ms) as avg_latency_ms
    FROM requests
    WHERE created_at >= ?
  `).get(since) as any;

  const costStats = db.prepare(`
    SELECT
      SUM(r.input_tokens * COALESCE(m.input_cost_per_1m, 3) / 1000000.0) as input_cost,
      SUM(r.output_tokens * COALESCE(m.output_cost_per_1m, 15) / 1000000.0) as output_cost
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
  `).get(since) as any;

  const totalRequests = stats.total_requests ?? 0;
  const successRate = totalRequests > 0 ? (stats.success_count / totalRequests) * 100 : 0;
  const totalTokens = (stats.total_input_tokens ?? 0) + (stats.total_output_tokens ?? 0);

  const inputCost = costStats.input_cost ?? 0;
  const outputCost = costStats.output_cost ?? 0;

  res.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: stats.total_input_tokens ?? 0,
    totalOutputTokens: stats.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(stats.avg_latency_ms ?? 0),
    estimatedCostSavings: Math.round((inputCost + outputCost) * 100) / 100,
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
      m.input_cost_per_1m,
      m.output_cost_per_1m,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    GROUP BY r.platform, r.model_id
    ORDER BY requests DESC
  `).all(since) as any[];

  res.json(rows.map(r => {
    const inputCost = ((r.total_input_tokens ?? 0) / 1_000_000) * (r.input_cost_per_1m ?? 3);
    const outputCost = ((r.total_output_tokens ?? 0) / 1_000_000) * (r.output_cost_per_1m ?? 15);
    return {
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name ?? r.model_id,
      requests: r.requests,
      successRate: Math.round(r.success_rate * 10) / 10,
      avgLatencyMs: Math.round(r.avg_latency_ms),
      totalInputTokens: r.total_input_tokens ?? 0,
      totalOutputTokens: r.total_output_tokens ?? 0,
      estimatedCost: Math.round((inputCost + outputCost) * 100) / 100,
    };
  }));
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
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(latency_ms) as avg_latency_ms,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens
    FROM requests
    WHERE created_at >= ?
    GROUP BY platform
    ORDER BY requests DESC
  `).all(since) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
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
  const interval = (req.query.interval as string) ?? (range === '1h' ? 'minute' : range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);
  const db = getDb();

  // dateFormat is a hardcoded whitelist — never user-controlled.
  const dateFormat = interval === 'minute' ? '%Y-%m-%dT%H:%M:00' : interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', created_at) as timestamp,
      COUNT(*) as requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failure_count
    FROM requests
    WHERE created_at >= ?
    GROUP BY strftime('${dateFormat}', created_at)
    ORDER BY timestamp ASC
  `).all(since) as any[];

  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    requests: r.requests,
    successCount: r.success_count,
    failureCount: r.failure_count,
  })));
});

// Per-model timeline data
analyticsRouter.get('/by-model-timeline', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const interval = (req.query.interval as string) ?? (range === '1h' ? 'minute' : range === '24h' ? 'hour' : 'day');
  const since = getSinceTimestamp(range);
  const db = getDb();

  const dateFormat = interval === 'minute' ? '%Y-%m-%dT%H:%M:00' : interval === 'hour' ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  const rows = db.prepare(`
    SELECT
      strftime('${dateFormat}', r.created_at) as timestamp,
      r.platform,
      r.model_id,
      m.input_cost_per_1m,
      m.output_cost_per_1m,
      COUNT(*) as requests,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ?
    GROUP BY strftime('${dateFormat}', r.created_at), r.platform, r.model_id
    ORDER BY timestamp ASC
  `).all(since) as any[];

  res.json(rows.map(r => {
    const inputCost = ((r.total_input_tokens ?? 0) / 1_000_000) * (r.input_cost_per_1m ?? 3);
    const outputCost = ((r.total_output_tokens ?? 0) / 1_000_000) * (r.output_cost_per_1m ?? 15);
    return {
      timestamp: r.timestamp,
      platform: r.platform,
      modelId: r.model_id,
      requests: r.requests,
      totalInputTokens: r.total_input_tokens ?? 0,
      totalOutputTokens: r.total_output_tokens ?? 0,
      estimatedCost: Math.round((inputCost + outputCost) * 100) / 100,
    };
  }));
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

// Live request log (last N requests, optionally errors only)
analyticsRouter.get('/live-requests', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '7d';
  const errorsOnly = req.query.errorsOnly === 'true';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      r.id,
      r.platform,
      r.model_id,
      COALESCE(m.display_name, r.model_id) as display_name,
      r.status,
      r.latency_ms,
      r.error,
      r.created_at
    FROM requests r
    LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
    WHERE r.created_at >= ? ${errorsOnly ? "AND r.status = 'error'" : ''}
    ORDER BY r.created_at DESC
    LIMIT 100
  `).all(since) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name,
    status: r.status,
    latencyMs: r.latency_ms,
    error: r.error,
    createdAt: r.created_at,
  })));
});
