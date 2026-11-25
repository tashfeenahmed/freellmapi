import { dashboardClient, type DashboardOptions } from './dashboard.js';
import { count, formatTable, ms, oneLine, percent } from './table.js';

export interface AnalyticsOptions extends DashboardOptions {
  args: string[];
  dryRun: boolean;
  json: boolean;
  range?: string;
  top?: string;
  limit?: string;
  requestStatus?: string;
}

const RANGES = ['24h', '7d', '30d', 'all'];
const STATUSES = ['success', 'error', 'canceled'];

export function analyticsHelp(command: 'usage' | 'requests'): string {
  return command === 'usage'
    ? [
      'Usage totals and per-provider split (dashboard authentication):',
      '  freellmapi usage [--range 24h|7d|30d|all] [--top N] [--json]',
      '',
      'Defaults: --range 7d, --top 10. Options: --url URL, --token TOKEN, --timeout MS.',
    ].join('\n')
    : [
      'Recent request log, newest first (dashboard authentication):',
      '  freellmapi requests [--range 24h|7d|30d|all] [--status success|error|canceled] [--limit N] [--json]',
      '',
      'Defaults: --range 24h, --limit 20 (at most 500). Options: --url URL, --token TOKEN, --timeout MS.',
    ].join('\n');
}

function parseRange(value: string | undefined, fallback: string): string {
  const range = value ?? fallback;
  if (!RANGES.includes(range)) throw new Error(`--range must be one of ${RANGES.join(', ')}`);
  return range;
}

function parsePositive(flag: string, value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(n) || n > max) {
    throw new Error(`${flag} must be an integer from 1 to ${max}`);
  }
  return n;
}

function reject(command: string, options: AnalyticsOptions, allowed: Array<'range' | 'top' | 'limit' | 'requestStatus'>): void {
  if (options.args.length) throw new Error(`Unknown option: ${options.args[0]}`);
  if (options.dryRun) throw new Error(`--dry-run is not supported by ${command}; no request was made`);
  const flags = { range: '--range', top: '--top', limit: '--limit', requestStatus: '--status' } as const;
  for (const key of Object.keys(flags) as Array<keyof typeof flags>) {
    if (options[key] !== undefined && !allowed.includes(key)) {
      throw new Error(`${flags[key]} is not supported by ${command}`);
    }
  }
}

interface Summary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  p95LatencyMs: number | null;
}

interface ProviderRow {
  platform: string;
  providerId?: string;
  endpoint?: string;
  requests: number;
  successRate: number;
  errorCount: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export async function runUsage(options: AnalyticsOptions): Promise<number> {
  reject('usage', options, ['range', 'top']);
  const range = parseRange(options.range, '7d');
  const top = parsePositive('--top', options.top, 10, 1000);
  const { request } = dashboardClient(options);
  const query = `?${new URLSearchParams({ range })}`;
  const summary = await request<Summary>(`/api/analytics/summary${query}`);
  const providers = await request<ProviderRow[]>(`/api/analytics/by-platform${query}`);
  if (!summary || typeof summary.totalRequests !== 'number' || !Array.isArray(providers)) {
    throw new Error('The gateway returned an invalid analytics response');
  }
  // The route already orders by request count; the sort keeps that true if it changes.
  const ranked = [...providers].sort((a, b) => b.requests - a.requests);
  const shown = ranked.slice(0, top);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ range, summary, providers: shown, providerCount: ranked.length }, null, 2)}\n`);
    return 0;
  }

  const out = [
    `Usage, range ${range}`,
    `Requests  ${count(summary.totalRequests)}  (success ${percent(summary.successRate)})`,
    `Tokens    ${count(summary.totalInputTokens)} in, ${count(summary.totalOutputTokens)} out`,
    `Latency   avg ${ms(summary.avgLatencyMs)}, p95 ${ms(summary.p95LatencyMs)}`,
    '',
  ];
  out.push(shown.length
    ? formatTable(['PROVIDER', 'REQUESTS', 'SUCCESS', 'ERRORS', 'AVG LATENCY', 'TOKENS IN', 'TOKENS OUT'],
      shown.map(row => [
        oneLine(row.endpoint ?? row.platform, 40), count(row.requests), percent(row.successRate), count(row.errorCount),
        ms(row.avgLatencyMs), count(row.totalInputTokens), count(row.totalOutputTokens),
      ]), [1, 2, 3, 4, 5, 6])
    : 'No requests in this range.');
  if (ranked.length > shown.length) out.push(`... and ${ranked.length - shown.length} more (raise --top)`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

interface RequestRow {
  createdAt: string;
  status: string;
  requestType: string | null;
  platform: string;
  modelId: string;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

export async function runRequests(options: AnalyticsOptions): Promise<number> {
  reject('requests', options, ['range', 'limit', 'requestStatus']);
  const range = parseRange(options.range, '24h');
  const limit = parsePositive('--limit', options.limit, 20, 500);
  if (options.requestStatus !== undefined && !STATUSES.includes(options.requestStatus)) {
    throw new Error(`--status must be one of ${STATUSES.join(', ')}`);
  }
  const { request } = dashboardClient(options);
  const query = new URLSearchParams({ range, limit: String(limit) });
  if (options.requestStatus) query.set('status', options.requestStatus);
  const result = await request<{ total: number; rows: RequestRow[] }>(`/api/analytics/requests?${query}`);
  if (!result || !Array.isArray(result.rows)) throw new Error('The gateway returned an invalid request log');

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ range, total: result.total, rows: result.rows }, null, 2)}\n`);
    return 0;
  }

  const out: string[] = [];
  if (result.rows.length) {
    out.push(formatTable(['TIME', 'STATUS', 'TYPE', 'MODEL', 'LATENCY', 'TOKENS', 'ERROR'],
      result.rows.map(row => [
        oneLine(row.createdAt, 20), oneLine(row.status, 10), oneLine(row.requestType, 14),
        oneLine(`${row.platform}/${row.modelId}`, 48), ms(row.latencyMs),
        `${count(row.inputTokens ?? 0)}/${count(row.outputTokens ?? 0)}`, oneLine(row.error, 60),
      ]), [4, 5]));
  } else {
    out.push('No matching requests.');
  }
  out.push(`Showing ${result.rows.length} of ${count(result.total)} in range ${range}`);
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}
