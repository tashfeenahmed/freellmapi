const DEFAULT_RPM = 120;

function parseRateLimitRpm(): number {
  const raw = process.env.PROXY_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RPM;
  return Math.floor(n);
}

export interface Config {
  port: number | string;
  host: string;
  dashboardOrigins: string[];
  clientDist: string | null;
  proxyRateLimitRpm: number;
  nodeEnv: string;
  serveStaticAssets: boolean;
}

export function loadConfig(): Config {
  return {
    port: process.env.PORT ?? 3001,
    // Dual-stack ('::') by default so the dashboard is reachable over both IPv4
    // and IPv6 (e.g. IPv6-enabled Docker networks — #180). Hosts with IPv6
    // disabled fall back to IPv4-only below; HOST overrides the default outright.
    host: process.env.HOST ?? '::',
    dashboardOrigins: (process.env.DASHBOARD_ORIGINS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    clientDist: process.env.CLIENT_DIST ?? null,
    proxyRateLimitRpm: parseRateLimitRpm(),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    serveStaticAssets: true,
  };
}
