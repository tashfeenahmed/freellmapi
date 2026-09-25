import { getPostgresPool } from '../db/postgres.js';

export interface RequestTelemetryEvent {
  providerId: number | null;
  providerKey: string;
  modelId: string;
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  isRateLimit?: boolean;
  isTimeout?: boolean;
  fallbackCount?: number;
  timestamp?: number;
}

export interface HourlyBucketData {
  bucketStart: string; // ISO string rounded to hour
  providerId: number | null;
  modelId: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencySumMs: number;
  latencyCount: number;
  rateLimitCount: number;
  timeoutCount: number;
  fallbackCount: number;
}

class AnalyticsAggregator {
  private buffer = new Map<string, HourlyBucketData>();
  private flushTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  private getBucketKey(timestamp: number, providerId: number | null, modelId: string): { key: string; bucketStart: string } {
    const d = new Date(timestamp);
    d.setMinutes(0, 0, 0);
    const bucketStart = d.toISOString();
    const key = `${bucketStart}:${providerId ?? 'null'}:${modelId.toLowerCase()}`;
    return { key, bucketStart };
  }

  /**
   * Records request telemetry in memory. Zero database operations!
   */
  record(event: RequestTelemetryEvent): void {
    const now = event.timestamp || Date.now();
    const { key, bucketStart } = this.getBucketKey(now, event.providerId, event.modelId);

    let bucket = this.buffer.get(key);
    if (!bucket) {
      bucket = {
        bucketStart,
        providerId: event.providerId,
        modelId: event.modelId,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencySumMs: 0,
        latencyCount: 0,
        rateLimitCount: 0,
        timeoutCount: 0,
        fallbackCount: 0,
      };
      this.buffer.set(key, bucket);
    }

    bucket.requestCount += 1;
    if (event.success) {
      bucket.successCount += 1;
    } else {
      bucket.failureCount += 1;
    }

    bucket.inputTokens += Math.max(0, event.inputTokens || 0);
    bucket.outputTokens += Math.max(0, event.outputTokens || 0);
    bucket.totalTokens += Math.max(0, event.totalTokens || 0);

    if (event.latencyMs > 0) {
      bucket.latencySumMs += event.latencyMs;
      bucket.latencyCount += 1;
    }

    if (event.isRateLimit) {
      bucket.rateLimitCount += 1;
    }

    if (event.isTimeout) {
      bucket.timeoutCount += 1;
    }

    if (event.fallbackCount && event.fallbackCount > 0) {
      bucket.fallbackCount += event.fallbackCount;
    }
  }

  /**
   * Flushes in-memory aggregated hourly buckets to PostgreSQL with batched upserts.
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.size === 0) {
      return;
    }

    this.isFlushing = true;
    const itemsToFlush = Array.from(this.buffer.values());
    this.buffer.clear();

    try {
      const pool = getPostgresPool();

      // Batch insert with ON CONFLICT DO UPDATE
      for (const item of itemsToFlush) {
        await pool.query(
          `INSERT INTO analytics_hourly (
             bucket_start, provider_id, model_id,
             request_count, success_count, failure_count,
             input_tokens, output_tokens, total_tokens,
             latency_sum_ms, latency_count,
             rate_limit_count, timeout_count, fallback_count
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (bucket_start, provider_id, model_id) DO UPDATE SET
             request_count = analytics_hourly.request_count + EXCLUDED.request_count,
             success_count = analytics_hourly.success_count + EXCLUDED.success_count,
             failure_count = analytics_hourly.failure_count + EXCLUDED.failure_count,
             input_tokens = analytics_hourly.input_tokens + EXCLUDED.input_tokens,
             output_tokens = analytics_hourly.output_tokens + EXCLUDED.output_tokens,
             total_tokens = analytics_hourly.total_tokens + EXCLUDED.total_tokens,
             latency_sum_ms = analytics_hourly.latency_sum_ms + EXCLUDED.latency_sum_ms,
             latency_count = analytics_hourly.latency_count + EXCLUDED.latency_count,
             rate_limit_count = analytics_hourly.rate_limit_count + EXCLUDED.rate_limit_count,
             timeout_count = analytics_hourly.timeout_count + EXCLUDED.timeout_count,
             fallback_count = analytics_hourly.fallback_count + EXCLUDED.fallback_count`,
          [
            item.bucketStart,
            item.providerId,
            item.modelId,
            item.requestCount,
            item.successCount,
            item.failureCount,
            item.inputTokens,
            item.outputTokens,
            item.totalTokens,
            item.latencySumMs,
            item.latencyCount,
            item.rateLimitCount,
            item.timeoutCount,
            item.fallbackCount,
          ]
        );
      }
    } catch (err: any) {
      // Failure of analytics must NEVER crash the server or break inference
      console.warn('[analytics-aggregator] Batch flush warning:', err?.message || err);
      // Re-add items to buffer if flush failed so they aren't lost
      for (const item of itemsToFlush) {
        const key = `${item.bucketStart}:${item.providerId ?? 'null'}:${item.modelId.toLowerCase()}`;
        const existing = this.buffer.get(key);
        if (existing) {
          existing.requestCount += item.requestCount;
          existing.successCount += item.successCount;
          existing.failureCount += item.failureCount;
          existing.inputTokens += item.inputTokens;
          existing.outputTokens += item.outputTokens;
          existing.totalTokens += item.totalTokens;
          existing.latencySumMs += item.latencySumMs;
          existing.latencyCount += item.latencyCount;
          existing.rateLimitCount += item.rateLimitCount;
          existing.timeoutCount += item.timeoutCount;
          existing.fallbackCount += item.fallbackCount;
        } else {
          this.buffer.set(key, item);
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Starts periodic batch flush and daily retention cleanup.
   */
  start(): void {
    const flushInterval = Number(process.env.ANALYTICS_FLUSH_INTERVAL_MS || 60000); // 1 minute default
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, flushInterval);

    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }

    // Daily retention cleanup (runs once every 24 hours)
    const retentionDays = Number(process.env.ANALYTICS_RETENTION_DAYS || 90);
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    const runRetention = async () => {
      try {
        const pool = getPostgresPool();
        const cutoff = new Date(Date.now() - retentionDays * ONE_DAY_MS).toISOString();
        await pool.query('DELETE FROM analytics_hourly WHERE bucket_start < $1', [cutoff]);
      } catch (err: any) {
        console.warn('[analytics-aggregator] Retention cleanup warning:', err?.message);
      }
    };

    // Run once on start then daily
    runRetention().catch(() => {});
    this.retentionTimer = setInterval(runRetention, ONE_DAY_MS);
    if (this.retentionTimer.unref) {
      this.retentionTimer.unref();
    }
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  getUnflushedBuffer(): HourlyBucketData[] {
    return Array.from(this.buffer.values());
  }
}

export const analyticsAggregator = new AnalyticsAggregator();

export function recordRequestTelemetry(event: RequestTelemetryEvent): void {
  analyticsAggregator.record(event);
}
