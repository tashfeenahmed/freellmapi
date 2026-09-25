import { Router } from 'express';
import type { Request, Response } from 'express';
import { getPostgresPool } from '../db/postgres.js';
import { analyticsAggregator } from '../services/analytics-aggregator.js';
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M } from '../db/model-pricing.js';

export const analyticsRouter = Router();

function getCutoffDate(range: string): Date {
  const now = Date.now();
  switch (range) {
    case '24h':
      return new Date(now - 24 * 60 * 60 * 1000);
    case '30d':
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case '90d':
      return new Date(now - 90 * 24 * 60 * 60 * 1000);
    case '7d':
    default:
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

// 1. Overview / Summary statistics
analyticsRouter.get('/summary', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    // Aggregated stats from Neon for the selected window
    const dbRes = await pool.query(
      `SELECT
         COALESCE(SUM(request_count), 0) as total_requests,
         COALESCE(SUM(success_count), 0) as success_count,
         COALESCE(SUM(failure_count), 0) as failure_count,
         COALESCE(SUM(input_tokens), 0) as total_input_tokens,
         COALESCE(SUM(output_tokens), 0) as total_output_tokens,
         COALESCE(SUM(total_tokens), 0) as total_tokens,
         COALESCE(SUM(latency_sum_ms), 0) as total_latency_ms,
         COALESCE(SUM(latency_count), 0) as total_latency_count,
         COALESCE(SUM(rate_limit_count), 0) as rate_limit_count,
         COALESCE(SUM(fallback_count), 0) as fallback_count
       FROM analytics_hourly
       WHERE bucket_start >= $1`,
      [cutoff.toISOString()]
    );

    // Estimated savings priced at each served model's paid-API equivalent rate
    const savingsRes = await pool.query(
      `SELECT COALESCE(SUM(
         a.input_tokens * COALESCE(m.input_price, $2) / 1000000.0 +
         a.output_tokens * COALESCE(m.output_price, $3) / 1000000.0
       ), 0) as est_savings
       FROM analytics_hourly a
       LEFT JOIN models m ON m.provider_id = a.provider_id AND m.model_id = a.model_id
       WHERE a.bucket_start >= $1`,
      [cutoff.toISOString(), FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M]
    );

    // Lifetime totals (window independent)
    const lifetimeRes = await pool.query(
      `SELECT COALESCE(SUM(request_count), 0) as total,
              MIN(bucket_start) as first_request_at
       FROM analytics_hourly`
    );

    const stats = dbRes.rows[0] || {};
    let totalRequests = Number(stats.total_requests || 0);
    let successCount = Number(stats.success_count || 0);
    let failureCount = Number(stats.failure_count || 0);
    let totalInputTokens = Number(stats.total_input_tokens || 0);
    let totalOutputTokens = Number(stats.total_output_tokens || 0);
    let totalTokens = Number(stats.total_tokens || 0);
    let totalLatencyMs = Number(stats.total_latency_ms || 0);
    let totalLatencyCount = Number(stats.total_latency_count || 0);
    let rateLimitCount = Number(stats.rate_limit_count || 0);
    let fallbackCount = Number(stats.fallback_count || 0);

    let estimatedCostSavings = Number(savingsRes.rows[0]?.est_savings || 0);
    let lifetimeTotalRequests = Number(lifetimeRes.rows[0]?.total || 0);
    let firstRequestAt = lifetimeRes.rows[0]?.first_request_at
      ? new Date(lifetimeRes.rows[0].first_request_at).toISOString()
      : null;

    // Merge with unflushed active in-memory buffer for real-time accuracy
    const unflushed = analyticsAggregator.getUnflushedBuffer();
    for (const b of unflushed) {
      lifetimeTotalRequests += b.requestCount;
      if (new Date(b.bucketStart) >= cutoff) {
        totalRequests += b.requestCount;
        successCount += b.successCount;
        failureCount += b.failureCount;
        totalInputTokens += b.inputTokens;
        totalOutputTokens += b.outputTokens;
        totalTokens += b.totalTokens;
        totalLatencyMs += b.latencySumMs;
        totalLatencyCount += b.latencyCount;
        rateLimitCount += b.rateLimitCount;
        fallbackCount += b.fallbackCount;
        estimatedCostSavings +=
          (b.inputTokens * FALLBACK_INPUT_PER_M + b.outputTokens * FALLBACK_OUTPUT_PER_M) / 1000000.0;
        if (!firstRequestAt || new Date(b.bucketStart) < new Date(firstRequestAt)) {
          firstRequestAt = b.bucketStart;
        }
      }
    }

    const decidedRequests = successCount + failureCount;
    const successRate = decidedRequests > 0 ? (successCount / decidedRequests) * 100 : 0;
    const avgLatencyMs = totalLatencyCount > 0 ? Math.round(totalLatencyMs / totalLatencyCount) : 0;

    res.json({
      totalRequests,
      successCount,
      failureCount,
      successRate: round1(successRate),
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      avgLatencyMs,
      totalLatencyMs,
      rateLimitCount,
      fallbackCount,
      estimatedCostSavings: round1(estimatedCostSavings),
      // Latency percentiles / TTFT / per-request details are not preserved in
      // the hourly aggregate; report null so the UI renders placeholders.
      p50LatencyMs: null,
      p95LatencyMs: null,
      avgTtfbMs: null,
      requestTypeCounts: { chat: totalRequests, embedding: 0 },
      pinnedRequests: 0,
      pinHonoredRequests: 0,
      firstRequestAt,
      lifetimeTotalRequests,
    });
  } catch (err: any) {
    console.error('[analytics] Error fetching summary:', err);
    res.status(500).json({ error: 'Failed to fetch analytics summary' });
  }
});

// Alias for /overview
analyticsRouter.get('/overview', (req, res) => {
  // Redirect internally to summary
  res.redirect(307, req.originalUrl.replace('/overview', '/summary'));
});

// 2. Provider breakdown (server-side aggregate endpoint, used by /by-platform)
analyticsRouter.get('/providers', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    const dbRes = await pool.query(
      `SELECT
         p.id as provider_id,
         p.provider_key,
         p.display_name,
         p.enabled,
         COALESCE(SUM(a.request_count), 0) as requests,
         COALESCE(SUM(a.success_count), 0) as success_count,
         COALESCE(SUM(a.failure_count), 0) as failure_count,
         COALESCE(SUM(a.input_tokens), 0) as input_tokens,
         COALESCE(SUM(a.output_tokens), 0) as output_tokens,
         COALESCE(SUM(a.total_tokens), 0) as total_tokens,
         COALESCE(SUM(a.latency_sum_ms), 0) as latency_sum_ms,
         COALESCE(SUM(a.latency_count), 0) as latency_count,
         COALESCE(SUM(a.rate_limit_count), 0) as rate_limit_count
       FROM providers p
       LEFT JOIN analytics_hourly a ON a.provider_id = p.id AND a.bucket_start >= $1
       GROUP BY p.id, p.provider_key, p.display_name, p.enabled
       ORDER BY requests DESC, p.priority DESC`,
      [cutoff.toISOString()]
    );

    const providerStatsMap = new Map<number, any>();
    for (const row of dbRes.rows) {
      providerStatsMap.set(row.provider_id, {
        providerId: row.provider_id,
        provider: row.provider_key,
        displayName: row.display_name,
        enabled: row.enabled,
        requests: Number(row.requests || 0),
        successCount: Number(row.success_count || 0),
        failureCount: Number(row.failure_count || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        totalTokens: Number(row.total_tokens || 0),
        latencySumMs: Number(row.latency_sum_ms || 0),
        latencyCount: Number(row.latency_count || 0),
        rateLimitCount: Number(row.rate_limit_count || 0),
      });
    }

    // Merge in-memory unflushed buffer
    const unflushed = analyticsAggregator.getUnflushedBuffer();
    for (const b of unflushed) {
      if (b.providerId && new Date(b.bucketStart) >= cutoff) {
        const stats = providerStatsMap.get(b.providerId);
        if (stats) {
          stats.requests += b.requestCount;
          stats.successCount += b.successCount;
          stats.failureCount += b.failureCount;
          stats.inputTokens += b.inputTokens;
          stats.outputTokens += b.outputTokens;
          stats.totalTokens += b.totalTokens;
          stats.latencySumMs += b.latencySumMs;
          stats.latencyCount += b.latencyCount;
          stats.rateLimitCount += b.rateLimitCount;
        }
      }
    }

    const results = Array.from(providerStatsMap.values()).map(p => {
      const decided = p.successCount + p.failureCount;
      const successRate = decided > 0 ? (p.successCount / decided) * 100 : 100;
      const avgLatencyMs = p.latencyCount > 0 ? Math.round(p.latencySumMs / p.latencyCount) : 0;
      return {
        provider: p.provider,
        displayName: p.displayName,
        enabled: p.enabled,
        requests: p.requests,
        successRate: round1(successRate),
        avgLatencyMs,
        totalInputTokens: p.inputTokens,
        totalOutputTokens: p.outputTokens,
        totalTokens: p.totalTokens,
        rateLimitCount: p.rateLimitCount,
      };
    });

    res.json(results);
  } catch (err: any) {
    console.error('[analytics] Error fetching providers:', err);
    res.status(500).json({ error: 'Failed to fetch provider stats' });
  }
});

// 3. Models breakdown (server-side aggregate endpoint, used by /by-model)
analyticsRouter.get('/models', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    const dbRes = await pool.query(
      `SELECT
         m.model_id,
         m.canonical_name,
         m.display_name,
         p.provider_key,
         COALESCE(SUM(a.request_count), 0) as requests,
         COALESCE(SUM(a.success_count), 0) as success_count,
         COALESCE(SUM(a.failure_count), 0) as failure_count,
         COALESCE(SUM(a.input_tokens), 0) as input_tokens,
         COALESCE(SUM(a.output_tokens), 0) as output_tokens,
         COALESCE(SUM(a.total_tokens), 0) as total_tokens,
         COALESCE(SUM(a.latency_sum_ms), 0) as latency_sum_ms,
         COALESCE(SUM(a.latency_count), 0) as latency_count
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       LEFT JOIN analytics_hourly a ON a.model_id = m.model_id AND a.provider_id = m.provider_id AND a.bucket_start >= $1
       GROUP BY m.model_id, m.canonical_name, m.display_name, p.provider_key
       ORDER BY requests DESC`,
      [cutoff.toISOString()]
    );

    const modelStatsMap = new Map<string, any>();
    for (const row of dbRes.rows) {
      const key = `${row.provider_key}:${row.model_id}`;
      modelStatsMap.set(key, {
        modelId: row.model_id,
        canonicalName: row.canonical_name,
        displayName: row.display_name,
        provider: row.provider_key,
        requests: Number(row.requests || 0),
        successCount: Number(row.success_count || 0),
        failureCount: Number(row.failure_count || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        totalTokens: Number(row.total_tokens || 0),
        latencySumMs: Number(row.latency_sum_ms || 0),
        latencyCount: Number(row.latency_count || 0),
      });
    }

    const results = Array.from(modelStatsMap.values()).map(m => {
      const decided = m.successCount + m.failureCount;
      const successRate = decided > 0 ? (m.successCount / decided) * 100 : 100;
      const avgLatencyMs = m.latencyCount > 0 ? Math.round(m.latencySumMs / m.latencyCount) : 0;
      return {
        modelId: m.modelId,
        canonicalName: m.canonicalName,
        displayName: m.displayName,
        provider: m.provider,
        requests: m.requests,
        successRate: round1(successRate),
        avgLatencyMs,
        totalInputTokens: m.inputTokens,
        totalOutputTokens: m.outputTokens,
        totalTokens: m.totalTokens,
      };
    });

    res.json(results);
  } catch (err: any) {
    console.error('[analytics] Error fetching models:', err);
    res.status(500).json({ error: 'Failed to fetch model stats' });
  }
});

// 4. Timeline / Timeseries points for charts (server-side aggregate endpoint,
//    used by /timeline)
analyticsRouter.get('/timeseries', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    const dbRes = await pool.query(
      `SELECT
         bucket_start as timestamp,
         SUM(request_count) as requests,
         SUM(success_count) as success_count,
         SUM(failure_count) as failure_count,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         SUM(total_tokens) as total_tokens,
         SUM(latency_sum_ms) as latency_sum_ms,
         SUM(latency_count) as latency_count
       FROM analytics_hourly
       WHERE bucket_start >= $1
       GROUP BY bucket_start
       ORDER BY bucket_start ASC`,
      [cutoff.toISOString()]
    );

    const timeMap = new Map<string, any>();
    for (const row of dbRes.rows) {
      const ts = new Date(row.timestamp).toISOString();
      timeMap.set(ts, {
        timestamp: ts,
        requests: Number(row.requests || 0),
        successCount: Number(row.success_count || 0),
        failureCount: Number(row.failure_count || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        totalTokens: Number(row.total_tokens || 0),
        latencySumMs: Number(row.latency_sum_ms || 0),
        latencyCount: Number(row.latency_count || 0),
      });
    }

    // Merge unflushed buffer
    const unflushed = analyticsAggregator.getUnflushedBuffer();
    for (const b of unflushed) {
      if (new Date(b.bucketStart) >= cutoff) {
        const ts = b.bucketStart;
        const point = timeMap.get(ts) ?? {
          timestamp: ts,
          requests: 0,
          successCount: 0,
          failureCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          latencySumMs: 0,
          latencyCount: 0,
        };
        timeMap.set(ts, point);
        point.requests += b.requestCount;
        point.successCount += b.successCount;
        point.failureCount += b.failureCount;
        point.inputTokens += b.inputTokens;
        point.outputTokens += b.outputTokens;
        point.totalTokens += b.totalTokens;
        point.latencySumMs += b.latencySumMs;
        point.latencyCount += b.latencyCount;
      }
    }

    const timeline = Array.from(timeMap.values())
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map(p => ({
        timestamp: p.timestamp,
        requests: p.requests,
        successCount: p.successCount,
        failureCount: p.failureCount,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        totalTokens: p.totalTokens,
        avgLatencyMs: p.latencyCount > 0 ? Math.round(p.latencySumMs / p.latencyCount) : 0,
      }));

    res.json(timeline);
  } catch (err: any) {
    console.error('[analytics] Error fetching timeseries:', err);
    res.status(500).json({ error: 'Failed to fetch timeseries stats' });
  }
});

// 5. Token metrics breakdown
analyticsRouter.get('/tokens', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    const dbRes = await pool.query(
      `SELECT
         p.provider_key as provider,
         COALESCE(SUM(a.input_tokens), 0) as input_tokens,
         COALESCE(SUM(a.output_tokens), 0) as output_tokens,
         COALESCE(SUM(a.total_tokens), 0) as total_tokens
       FROM analytics_hourly a
       JOIN providers p ON p.id = a.provider_id
       WHERE a.bucket_start >= $1
       GROUP BY p.provider_key
       ORDER BY total_tokens DESC`,
      [cutoff.toISOString()]
    );

    res.json(dbRes.rows.map(r => ({
      provider: r.provider,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      totalTokens: Number(r.total_tokens),
    })));
  } catch (err: any) {
    console.error('[analytics] Error fetching tokens:', err);
    res.status(500).json({ error: 'Failed to fetch token stats' });
  }
});

// ── Dashboard-facing endpoints (client-shape compatible) ─────────────────────

// Stats grouped by platform.
analyticsRouter.get('/by-platform', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    const dbRes = await pool.query(
      `SELECT
         p.id as provider_id,
         p.provider_key as platform,
         p.display_name,
         SUM(a.request_count) as requests,
         SUM(a.success_count) as success_count,
         SUM(a.failure_count) as failure_count,
         SUM(a.input_tokens) as input_tokens,
         SUM(a.output_tokens) as output_tokens,
         SUM(a.latency_sum_ms) as latency_sum_ms,
         SUM(a.latency_count) as latency_count,
         SUM(a.rate_limit_count) as rate_limit_count
       FROM analytics_hourly a
       JOIN providers p ON p.id = a.provider_id
       WHERE a.bucket_start >= $1
       GROUP BY p.id, p.provider_key, p.display_name
       ORDER BY requests DESC`,
      [cutoff.toISOString()]
    );

    const map = new Map<number, any>();
    for (const row of dbRes.rows) {
      map.set(row.provider_id, {
        providerId: row.provider_id,
        platform: row.platform,
        displayName: row.display_name,
        requests: Number(row.requests || 0),
        successCount: Number(row.success_count || 0),
        failureCount: Number(row.failure_count || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        latencySumMs: Number(row.latency_sum_ms || 0),
        latencyCount: Number(row.latency_count || 0),
        rateLimitCount: Number(row.rate_limit_count || 0),
      });
    }

    const unflushed = analyticsAggregator.getUnflushedBuffer();
    for (const b of unflushed) {
      if (b.providerId && new Date(b.bucketStart) >= cutoff) {
        const s = map.get(b.providerId);
        if (s) {
          s.requests += b.requestCount;
          s.successCount += b.successCount;
          s.failureCount += b.failureCount;
          s.inputTokens += b.inputTokens;
          s.outputTokens += b.outputTokens;
          s.latencySumMs += b.latencySumMs;
          s.latencyCount += b.latencyCount;
          s.rateLimitCount += b.rateLimitCount;
        }
      }
    }

    res.json(Array.from(map.values()).map(s => {
      const decided = s.successCount + s.failureCount;
      return {
        platform: s.platform,
        providerId: s.platform,
        endpoint: s.displayName,
        requests: s.requests,
        successRate: round1(decided > 0 ? (s.successCount / decided) * 100 : 0),
        avgLatencyMs: s.latencyCount > 0 ? Math.round(s.latencySumMs / s.latencyCount) : 0,
        p95LatencyMs: null,
        avgTtfbMs: null,
        errorCount: s.failureCount,
        avgTokensPerSecond: null,
        totalInputTokens: s.inputTokens,
        totalOutputTokens: s.outputTokens,
      };
    }));
  } catch (err: any) {
    console.error('[analytics] Error fetching by-platform:', err);
    res.status(500).json({ error: 'Failed to fetch platform stats' });
  }
});

// Stats grouped by model. endpoint-scoped identity is not available in the
// hourly aggregate, so custom endpoints roll up under the provider id.
analyticsRouter.get('/by-model', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    const dbRes = await pool.query(
      `SELECT
         p.id as provider_id,
         p.provider_key as platform,
         p.display_name as provider_name,
         a.model_id,
         COALESCE(m.display_name, a.model_id) as model_display_name,
         SUM(a.request_count) as requests,
         SUM(a.success_count) as success_count,
         SUM(a.failure_count) as failure_count,
         SUM(a.input_tokens) as input_tokens,
         SUM(a.output_tokens) as output_tokens,
         SUM(a.latency_sum_ms) as latency_sum_ms,
         SUM(a.latency_count) as latency_count,
         COALESCE(SUM(
           a.input_tokens * COALESCE(m.input_price, $2) / 1000000.0 +
           a.output_tokens * COALESCE(m.output_price, $3) / 1000000.0
         ), 0) as est_cost
       FROM analytics_hourly a
       JOIN providers p ON p.id = a.provider_id
       LEFT JOIN models m ON m.provider_id = a.provider_id AND m.model_id = a.model_id
       WHERE a.bucket_start >= $1
       GROUP BY p.id, p.provider_key, p.display_name, a.model_id, m.display_name
       ORDER BY requests DESC`,
      [cutoff.toISOString(), FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M]
    );

    const map = new Map<string, any>();
    const platformById = new Map<number, string>();
    for (const row of dbRes.rows) {
      const key = `${row.platform}:${row.model_id}`;
      map.set(key, {
        providerId: row.platform,
        endpoint: row.provider_name,
        modelId: row.model_id,
        displayName: row.model_display_name ?? row.model_id,
        requests: Number(row.requests || 0),
        successCount: Number(row.success_count || 0),
        failureCount: Number(row.failure_count || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        latencySumMs: Number(row.latency_sum_ms || 0),
        latencyCount: Number(row.latency_count || 0),
        estCost: Number(row.est_cost || 0),
      });
      platformById.set(row.provider_id, row.platform);
    }

    const unflushed = analyticsAggregator.getUnflushedBuffer();
    for (const b of unflushed) {
      if (new Date(b.bucketStart) >= cutoff) {
        const platform = b.providerId != null ? platformById.get(b.providerId) : undefined;
        const key = platform ? `${platform}:${b.modelId}` : `${b.modelId}`;
        const s = map.get(key);
        if (s) {
          s.requests += b.requestCount;
          s.successCount += b.successCount;
          s.failureCount += b.failureCount;
          s.inputTokens += b.inputTokens;
          s.outputTokens += b.outputTokens;
          s.latencySumMs += b.latencySumMs;
          s.latencyCount += b.latencyCount;
          s.estCost += (b.inputTokens * FALLBACK_INPUT_PER_M + b.outputTokens * FALLBACK_OUTPUT_PER_M) / 1000000.0;
        }
      }
    }

    res.json(Array.from(map.values()).map(s => {
      const decided = s.successCount + s.failureCount;
      return {
        platform: s.platform,
        providerId: s.providerId,
        endpoint: s.endpoint,
        modelId: s.modelId,
        displayName: s.displayName,
        requests: s.requests,
        successRate: round1(decided > 0 ? (s.successCount / decided) * 100 : 0),
        avgLatencyMs: s.latencyCount > 0 ? Math.round(s.latencySumMs / s.latencyCount) : 0,
        totalInputTokens: s.inputTokens,
        totalOutputTokens: s.outputTokens,
        pinnedRequests: 0,
        estimatedCost: round1(s.estCost),
      };
    }));
  } catch (err: any) {
    console.error('[analytics] Error fetching by-model:', err);
    res.status(500).json({ error: 'Failed to fetch model stats' });
  }
});

// Timeline data (hour or day buckets, shifted to the viewer's timezone).
analyticsRouter.get('/timeline', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const interval = (req.query.interval as string) ?? (range === '24h' ? 'hour' : 'day');
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    // tzOffset: viewer's local offset from UTC in minutes (480 = UTC+8), sent
    // by the browser so hour/day bucket boundaries follow the viewer's wall
    // clock instead of UTC. Whitelisted to a sane integer range and always
    // bound as a parameter — never interpolated.
    const rawOffset = Number(req.query.tzOffset);
    const tzOffset = Number.isInteger(rawOffset) && rawOffset >= -720 && rawOffset <= 840 ? rawOffset : 0;
    const useHour = interval === 'hour';

    const dbRes = await pool.query(
      `SELECT
         to_char(
           (date_trunc('hour', bucket_start) + ($2::double precision * interval '1 minute'))
             AT TIME ZONE 'UTC',
           $3
         ) as timestamp,
         SUM(request_count) as requests,
         SUM(success_count) as success_count,
         SUM(failure_count) as failure_count,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens
       FROM analytics_hourly
       WHERE bucket_start >= $1
       GROUP BY timestamp
       ORDER BY timestamp ASC`,
      [cutoff.toISOString(), tzOffset, useHour ? 'YYYY-MM-DD"T"HH24:00:00' : 'YYYY-MM-DD']
    );

    const timeMap = new Map<string, any>();
    for (const row of dbRes.rows) {
      timeMap.set(row.timestamp, {
        timestamp: row.timestamp,
        requests: Number(row.requests || 0),
        successCount: Number(row.success_count || 0),
        failureCount: Number(row.failure_count || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
      });
    }

    // Merge unflushed buffer (shift buckets to the viewer timezone in JS)
    const unflushed = analyticsAggregator.getUnflushedBuffer();
    for (const b of unflushed) {
      if (new Date(b.bucketStart) >= cutoff) {
        const shifted = new Date(new Date(b.bucketStart).getTime() + tzOffset * 60 * 1000);
        const ts = useHour
          ? `${shifted.toISOString().slice(0, 13)}:00:00`
          : shifted.toISOString().slice(0, 10);
        const point = timeMap.get(ts) ?? {
          timestamp: ts,
          requests: 0,
          successCount: 0,
          failureCount: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
        timeMap.set(ts, point);
        point.requests += b.requestCount;
        point.successCount += b.successCount;
        point.failureCount += b.failureCount;
        point.inputTokens += b.inputTokens;
        point.outputTokens += b.outputTokens;
      }
    }

    res.json(Array.from(timeMap.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
  } catch (err: any) {
    console.error('[analytics] Error fetching timeline:', err);
    res.status(500).json({ error: 'Failed to fetch timeline stats' });
  }
});

// Stats grouped by API key. The hourly aggregate carries no key dimension, so
// there is nothing to report until raw per-request logging is available.
analyticsRouter.get('/by-key', (_req: Request, res: Response) => {
  res.json([]);
});

// Stats grouped by client. The hourly aggregate carries no client dimension.
analyticsRouter.get('/by-client', (_req: Request, res: Response) => {
  res.json([]);
});

// Recent errors. Error messages are not persisted by the memory-first
// aggregator, so this stays empty until raw request logging returns.
analyticsRouter.get('/errors', (_req: Request, res: Response) => {
  res.json([]);
});

// Error distribution. Only aggregate failure counts are available; categorize
// them under a single catch-all bucket so the panels still render failures.
analyticsRouter.get('/error-distribution', async (req: Request, res: Response) => {
  try {
    const range = (req.query.range as string) ?? '7d';
    const cutoff = getCutoffDate(range);
    const pool = getPostgresPool();

    const dbRes = await pool.query(
      `SELECT
         p.id as provider_id,
         p.provider_key as platform,
         p.display_name,
         SUM(a.failure_count) as count
       FROM analytics_hourly a
       JOIN providers p ON p.id = a.provider_id
       WHERE a.bucket_start >= $1
       GROUP BY p.id, p.provider_key, p.display_name
       ORDER BY count DESC`,
      [cutoff.toISOString()]
    );

    let failureCount = 0;
    const byPlatform: Array<{ platform: string; providerId: string; endpoint: string; count: number }> = [];
    const platformById = new Map<number, string>();
    for (const row of dbRes.rows) {
      const count = Number(row.count || 0);
      failureCount += count;
      if (count > 0) {
        byPlatform.push({
          platform: row.platform,
          providerId: row.platform,
          endpoint: row.display_name,
          count,
        });
      }
      platformById.set(row.provider_id, row.platform);
    }

    // Merge unflushed buffer
    const unflushed = analyticsAggregator.getUnflushedBuffer();
    for (const b of unflushed) {
      if (b.providerId && new Date(b.bucketStart) >= cutoff) {
        failureCount += b.failureCount;
        const platform = platformById.get(b.providerId) ?? b.providerId.toString();
        const existing = byPlatform.find(p => p.providerId === platform);
        if (existing) existing.count += b.failureCount;
        else if (b.failureCount > 0) {
          byPlatform.push({ platform, providerId: platform, endpoint: platform, count: b.failureCount });
        }
      }
    }

    res.json({
      byCategory: failureCount > 0 ? [{ category: 'Other', count: failureCount }] : [],
      byPlatform,
      detailed: [],
    });
  } catch (err: any) {
    console.error('[analytics] Error fetching error distribution:', err);
    res.status(500).json({ error: 'Failed to fetch error distribution' });
  }
});

// Recent calls — one row per proxied request. Requires raw per-request logging
// which the memory-first hourly aggregator does not persist; returns an empty
// paged response so the table renders gracefully.
analyticsRouter.get('/requests', (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  if (status !== undefined && status !== 'success' && status !== 'error' && status !== 'canceled') {
    res.status(400).json({ error: "invalid status filter (expected 'success', 'error' or 'canceled')" });
    return;
  }
  res.json({ total: 0, rows: [] });
});

// Per-request detail (failover ladder). No raw requests are stored.
analyticsRouter.get('/requests/:id', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'request not found' });
});