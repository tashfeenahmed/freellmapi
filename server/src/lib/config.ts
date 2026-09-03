const DEFAULT_RPM = 120;

// JSON body ceiling for the LLM wire surfaces (/v1, /v1beta, /mcp, Ollama
// /api/*). Vision requests inline base64 images (~33% inflation over the raw
// bytes; google.ts alone forwards images up to 8MB, ~10.7MB in base64), so a
// single-screenshot Codex turn easily clears 10MB, and history replay stacks
// several of them (an 11.85MB real-world request was observed). express.json
// buffers the whole body in memory (2-3x transiently during the parse), so
// this also bounds the per-request spike on small containers. Anything past
// the ceiling 413s before routing — no fallback, no analytics row — so it
// must sit above the largest payload we expect to serve. 25MB is the balance
// point: it clears the observed 11.85MB replayed session with room to spare,
// while keeping the worst case survivable on the small hosts this runs on (a
// Pi or a 512MB VPS — the limit is PER REQUEST, so a handful of concurrent
// maximal bodies is the number that actually has to fit in RAM). Inbound
// image normalization shrinks payloads ~6-10x right after the parse, so the
// steady state sits far below this. Raise REQUEST_BODY_LIMIT_MB on a bigger
// box if a client genuinely sends more. The dashboard/admin surface keeps its
// own smaller fixed ceiling.
const DEFAULT_REQUEST_BODY_LIMIT_MB = 25;

function parseRateLimitRpm(): number {
  const raw = process.env.PROXY_RATE_LIMIT_RPM;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RPM;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RPM;
  return Math.floor(n);
}

function parseRequestBodyLimitBytes(): number {
  const raw = process.env.REQUEST_BODY_LIMIT_MB;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REQUEST_BODY_LIMIT_MB * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_REQUEST_BODY_LIMIT_MB * 1024 * 1024;
  return Math.floor(n) * 1024 * 1024;
}

export interface Config {
  port: number | string;
  host: string;
  dbPath: string | null;
  dashboardOrigins: string[];
  clientDist: string | null;
  proxyRateLimitRpm: number;
  /** JSON body limit (bytes) for the LLM wire surfaces — see
   *  parseRequestBodyLimitBytes. REQUEST_BODY_LIMIT_MB overrides. */
  requestBodyLimitBytes: number;
  nodeEnv: string;
  serveStaticAssets: boolean;
  /**
   * Express `trust proxy` setting, parsed from TRUST_PROXY (#1024).
   * - false:        do not trust forwarded headers (default; direct callers
   *                 cannot spoof X-Forwarded-For).
   * - true:         trust all proxies (with a security warning).
   * - number:       trust that many hops counted from the socket peer
   *                 (Express's `trust proxy: 1` idiom for one proxy in front).
   * - string[]:     trust only these proxy addresses/CIDRs.
   */
  trustProxy: boolean | number | string[];
  /**
   * Tri-state override for the CSP `upgrade-insecure-requests` directive (#682).
   * - undefined: auto — emit the directive only when the request arrived over
   *   TLS (or behind an HTTPS reverse proxy that forwarded X-Forwarded-Proto).
   * - true:      always emit (force HTTPS upgrade even on plain HTTP).
   * - false:     never emit (let HTTP LAN installs render the dashboard).
   */
  cspUpgradeInsecureRequests: boolean | undefined;
}

export function loadConfig(): Config {
  return {
    port: process.env.PORT ?? 3001,
    // Dual-stack ('::') by default so the dashboard is reachable over both IPv4
    // and IPv6 (e.g. IPv6-enabled Docker networks — #180). Hosts with IPv6
    // disabled fall back to IPv4-only below; HOST overrides the default outright.
    host: process.env.HOST ?? '::',
    dbPath: process.env.FREEAPI_DB_PATH?.trim() || null,
    dashboardOrigins: (process.env.DASHBOARD_ORIGINS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    clientDist: process.env.CLIENT_DIST ?? null,
    proxyRateLimitRpm: parseRateLimitRpm(),
    requestBodyLimitBytes: parseRequestBodyLimitBytes(),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    serveStaticAssets: true,
    trustProxy: parseTrustProxy(),
    // CSP_UPGRADE_INSECURE_REQUESTS: true|false forces the directive on/off;
    // unset (the default) leaves it on auto — emit only when the request is
    // already TLS or forwarded as https, so HTTP LAN installs still render.
    cspUpgradeInsecureRequests: parseCspUpgradeInsecureRequests(),
  };
}

// Parse TRUST_PROXY (#1024). unset/empty/false → false (do not trust forwarded
// headers); true → trust all proxies; a non-negative integer → that many hops
// from the socket peer (so `TRUST_PROXY=1` means "one proxy in front", the
// Express idiom, not "trust everything"); otherwise a comma-separated list of
// proxy addresses/CIDRs → trust only those hops.
function parseTrustProxy(): boolean | number | string[] {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === '') return false;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === 'yes') return true;
  if (lower === 'false' || lower === 'no') return false;
  if (/^\d+$/.test(lower)) {
    const hops = Number(lower);
    return hops > 0 ? hops : false;
  }
  const addrs = raw.split(',').map(s => s.trim()).filter(Boolean);
  return addrs.length > 0 ? addrs : false;
}

function parseCspUpgradeInsecureRequests(): boolean | undefined {
  const raw = process.env.CSP_UPGRADE_INSECURE_REQUESTS;
  if (raw === undefined || raw.trim() === '') return undefined;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}
