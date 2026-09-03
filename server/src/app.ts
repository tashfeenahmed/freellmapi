import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { keysRouter } from './routes/keys.js';
import { clientProfilesRouter } from './routes/client-profiles.js';
import { conversationsRouter } from './routes/conversations.js';
import { logsRouter } from './routes/logs.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { responsesRouter } from './routes/responses.js';
import { anthropicRouter } from './routes/anthropic.js';
import { fallbackRouter } from './routes/fallback.js';
import { profilesRouter } from './routes/profiles.js';
import { embeddingsRouter } from './routes/embeddings.js';
import { mediaRouter } from './routes/media.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { freeTierRouter } from './routes/free-tier.js';
import { settingsRouter } from './routes/settings.js';
import { premiumRouter } from './routes/premium.js';
import { backupsRouter } from './routes/backups.js';
import { cacheRouter } from './routes/cache.js';
import { compressionRouter } from './routes/compression.js';
import { authRouter } from './routes/auth.js';
import { docsRouter } from './routes/docs.js';
import { mcpRouter } from './routes/mcp.js';
import { statusRouter, providersRouter } from './routes/status.js';
import { geminiRouter } from './routes/gemini.js';
import { ollamaRouter } from './routes/ollama.js';
import { urlTokenRouter } from './routes/url-tokens.js';
import { updateRouter } from './routes/update.js';
import { requireAuth } from './middleware/requireAuth.js';
import { createProxyRateLimiter, createAdminRateLimiter } from './middleware/rateLimit.js';

// Password-guess ceiling for GET /api/keys/export. Deliberately low: a real
// user exports keys occasionally, never ten times a minute.
const EXPORT_RATE_LIMIT_RPM = 10;
import { errorHandler } from './middleware/errorHandler.js';
import { clientContextMiddleware } from './lib/client-context.js';
import type { Config } from './lib/config.js';
import { loadConfig } from './lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DASHBOARD_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
];

// SHA-256 of the inline theme/direction bootstrap in client/index.html, which
// must run before first paint. Kept as a literal so the CSP header stays a
// constant string; csp-inline-bootstrap.test.ts recomputes it from the real
// index.html (source and build) and fails if the two ever drift apart.
export const INLINE_BOOTSTRAP_SHA = "'sha256-4Mz/yZAENQGlTAAeE1WqXruXCripvlvl0s+Q9S1VS4A='";

// A build asset is safe to cache forever+immutable when its URL is
// content-addressed. Vite parks every hashed chunk (JS, CSS, fonts, images)
// under assets/, so that directory is the reliable signal; the -<hash>.<ext>
// suffix is a belt-and-braces fallback for any hashed file emitted elsewhere.
// index.html and other unhashed entries deliberately fall through to no-cache.
const HASHED_ASSET_RE = /-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/;
function isImmutableAsset(filePath: string): boolean {
  return (
    filePath.includes(`${path.sep}assets${path.sep}`) ||
    HASHED_ASSET_RE.test(path.basename(filePath))
  );
}

// Loopback and *.localhost are "potentially trustworthy" origins even over
// plain HTTP (https://www.w3.org/TR/powerful-features/#is-origin-trustworthy),
// so a desktop/localhost install still gets the secure-context-only headers.
const LOOPBACK_HOST_RE = /^(?:localhost|[^.]+(?:\.[^.]+)*\.localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

// TLS terminated here (req.secure), or in front of us and forwarded. The
// X-Forwarded-Proto check is the documented reverse-proxy setup for publishing
// the proxy beyond localhost.
function isHttpsRequest(req: express.Request): boolean {
  const forwardedProto = req.headers['x-forwarded-proto'];
  // A proxy chain sends a comma-separated list; the client-facing hop is first.
  const first = String(forwardedProto ?? '').split(',')[0]!.trim().toLowerCase();
  return first === 'https' || req.secure;
}

// Whether the browser will treat this origin as a secure context. Headers that
// only apply to secure contexts are worse than useless elsewhere: the browser
// drops them and logs an error, which is exactly what a plain-HTTP LAN install
// reported in #734.
function isTrustworthyOrigin(req: express.Request): boolean {
  return isHttpsRequest(req) || LOOPBACK_HOST_RE.test(req.hostname ?? '');
}

export function createApp(config?: Config) {
  const cfg = config ?? loadConfig();
  const app = express();
  // TRUST_PROXY (#1024): opt-in trust of X-Forwarded-* from a reverse proxy.
  // false (default) ignores forwarded headers so direct callers cannot spoof
  // the client IP; true trusts every hop; a comma-separated list of addresses
  // /CIDRs trusts only those proxies. Must be set before client-context and
  // the rate-limit middleware, which both resolve the client IP.
  app.set('trust proxy', cfg.trustProxy);
  const allowedCorsOrigins = new Set([
    ...DEFAULT_DASHBOARD_ORIGINS,
    ...cfg.dashboardOrigins,
  ]);

  // CSP: default-src 'self' restricts content to the same origin. Scripts
  // are hashed by the Vite/React build, so 'self' works in production. Inline
  // styles from React hydration need 'unsafe-inline'. HSTS stays off because
  // this is a single-user local proxy served over HTTP (see README).
  //
  // `upgrade-insecure-requests` is emitted by Helmet by default; v0.6.6's
  // CSP hardening (#498) inherited it and broke HTTP LAN installs because the
  // browser rewrites /assets/* to https:// on an origin that has no TLS,
  // producing ERR_SSL_PROTOCOL_ERROR and a blank dashboard (#682).
  // The directive is dropped from the static Helmet config and re-added per
  // request below, gated by protocol + the CSP_UPGRADE_INSECURE_REQUESTS env.
  //
  // Cross-Origin-Opener-Policy and Origin-Agent-Cluster are handled the same
  // way, for the same reason: both only apply to secure contexts, so on a
  // plain-HTTP LAN origin the browser discards them and logs a console error
  // instead (#734). They are re-added per request whenever the origin is one
  // the browser trusts — HTTPS, or loopback, which covers desktop/localhost.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // index.html carries one inline <script>: the theme/direction bootstrap
        // that has to run before first paint, or every dark-mode user gets a
        // white flash. 'self' alone blocks it on every install, HTTPS included,
        // so it is allowed by hash — nothing else inline is. INLINE_BOOTSTRAP_SHA
        // is asserted against the real index.html in csp-inline-bootstrap.test.ts,
        // so editing that script fails the suite instead of silently breaking it.
        scriptSrc: ["'self'", INLINE_BOOTSTRAP_SHA],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  }));
  // Per-request re-issue of the headers that depend on how the page was
  // reached. Only HTTPS origins should tell the browser to upgrade http→https,
  // since plain-HTTP LAN setups have no TLS to upgrade to; the env flag
  // overrides that either way. COOP and Origin-Agent-Cluster go back on for any
  // origin the browser considers trustworthy (HTTPS or loopback), which is
  // every origin that would have honoured them in the first place.
  // Helmet ran above and synchronously set its headers on res; this runs next,
  // still before any route handler writes the body, so setHeader here lands
  // before the response is flushed.
  app.use((req, res, next) => {
    const shouldEmit =
      cfg.cspUpgradeInsecureRequests === true ||
      (cfg.cspUpgradeInsecureRequests === undefined && isHttpsRequest(req));

    if (shouldEmit) {
      const csp = res.getHeader('content-security-policy');
      if (typeof csp === 'string' && !csp.includes('upgrade-insecure-requests')) {
        res.setHeader('content-security-policy', `${csp}; upgrade-insecure-requests`);
      }
    }

    if (isTrustworthyOrigin(req)) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Origin-Agent-Cluster', '?1');
    }

    next();
  });
  app.use(cors({
    origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
      callback(null, !origin || allowedCorsOrigins.has(origin));
    },
  }));
  // Two-tier JSON body limits. The LLM wire surfaces carry vision payloads —
  // base64 images inline in the body (~33% inflation; google.ts forwards
  // images up to 8MB apiece) — so a single-screenshot Codex turn can clear
  // 10MB and used to 413 HERE, before auth/routing: no fallback attempt, no
  // analytics row, just an opaque 'request entity too large'. Those surfaces
  // get the larger REQUEST_BODY_LIMIT_MB ceiling (default 25MB); everything
  // else keeps the #200 limit — code agents (OpenCode, AionUI, Qwen Code)
  // ship very large system prompts + tool schemas + repo context, and 1mb cut
  // their sessions off mid-conversation. body-parser skips requests whose
  // body was already parsed, so the second parser only sees what the first
  // didn't own; an over-limit body throws from whichever parser matched.
  app.use(
    ['/v1', '/v1beta', '/mcp', '/api/chat', '/api/generate', '/api/embed', '/api/embeddings'],
    express.json({ limit: cfg.requestBodyLimitBytes }),
  );
  app.use(express.json({ limit: '10mb' }));

  // Caller identity (IP + User-Agent) for request analytics, carried in
  // AsyncLocalStorage so logRequest() can read it from any depth.
  app.use(clientContextMiddleware);

  // Ollama emulation owns only its exact fixed /api/* paths. Mount it before
  // the dashboard session gate because real Ollama clients do not use that
  // auth scheme. Its legacy /api/embeddings handler explicitly falls through
  // when it sees a valid dashboard session.
  // The same per-IP limiter as /v1 runs first: key-required mode is a
  // brute-forceable credential check without it. Dashboard traffic on the
  // shared /api/embeddings path shares the (generous, configurable) budget.
  app.use(
    ['/api/tags', '/api/version', '/api/show', '/api/chat', '/api/generate', '/api/embed', '/api/embeddings'],
    createProxyRateLimiter(cfg.proxyRateLimitRpm),
  );
  app.use(ollamaRouter);

  // Dashboard auth (#35): /api/auth/{status,setup,login} bootstrap without a
  // session; everything else under /api/* requires a logged-in dashboard user.
  // The /v1 proxy keeps its own unified-API-key auth and is NOT gated here.
  app.use('/api/auth', authRouter);

  // Admin API — all routes share an IP-based rate limiter to throttle
  // brute-force attempts (auth, key export, etc). The limiter is mounted
  // broadly on /api; requireAuth gates each sub-path individually so that
  // unauthenticated endpoints under /api (like /api/ping) are not blocked.
  const adminRateLimiter = createAdminRateLimiter();
  app.use('/api', adminRateLimiter);

  // Key export re-verifies the dashboard password, which makes it the one admin
  // endpoint a guesser can attack. The broad limiter above is sized for normal
  // dashboard traffic and far too loose for that, so this path gets its own
  // tight per-IP bucket on top of it.
  app.use('/api/keys/export', createAdminRateLimiter(EXPORT_RATE_LIMIT_RPM));

  app.use('/api/keys', requireAuth, keysRouter);
  // Per-client key management (#411). Dashboard-session gated like the rest of
  // /api — the profile keys it mints authenticate only the /v1 inference
  // surface and are never valid here.
  app.use('/api/client-profiles', requireAuth, clientProfilesRouter);
  // Saved Playground transcripts (the chat sidebar). Dashboard-session gated
  // like every other admin route; the unified /v1 key does not open it.
  app.use('/api/conversations', requireAuth, conversationsRouter);
  // Server logs for the dashboard viewer. Dashboard-session gated like the rest
  // of /api — these lines name providers, models and key ids, so the unified
  // /v1 key must not open them.
  app.use('/api/logs', requireAuth, logsRouter);
  app.use('/api/models', requireAuth, modelsRouter);
  app.use('/api/profiles', requireAuth, profilesRouter);
  app.use('/api/fallback', requireAuth, fallbackRouter);
  app.use('/api/embeddings', requireAuth, embeddingsRouter);
  app.use('/api/media', requireAuth, mediaRouter);
  app.use('/api/analytics', requireAuth, analyticsRouter);
  app.use('/api/health', requireAuth, healthRouter);
  app.use('/api/free-tier', requireAuth, freeTierRouter);
  app.use('/api/settings', requireAuth, settingsRouter);
  app.use('/api/premium', requireAuth, premiumRouter);
  // Database dumps and restores. Dashboard-session gated: the dump files carry
  // encrypted provider keys and every routing setting, so the unified /v1 key
  // must not open this surface.
  app.use('/api/backups', requireAuth, backupsRouter);
  app.use('/api/cache', requireAuth, cacheRouter);
  app.use('/api/compression', requireAuth, compressionRouter);
  app.use('/api/update', requireAuth, updateRouter);

  // Health check — no auth required.
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Static, unauthenticated API reference: GET /v1/docs (viewer) and
  // GET /v1/openapi.json (spec). Mounted before the rate limiter so the docs
  // are always reachable and don't draw down a caller's request budget. It only
  // owns those two paths; everything else falls through to the routers below.
  app.use('/v1', docsRouter);

  // Read-only per-upstream status for meta-gateways (GET /v1/providers, #433).
  // Unified-key auth is enforced inside the handler; mounted before the rate
  // limiter (like docsRouter) so status polling doesn't draw down a caller's
  // request budget.
  app.use('/v1', providersRouter);

  // Separately revocable URL tokens for clients that cannot set headers.
  app.use('/v1/t/:token', createProxyRateLimiter(cfg.proxyRateLimitRpm));
  app.use('/v1/t/:token', urlTokenRouter);

  // OpenAI-compatible proxy. Per-IP rate limiting (#35 item #6) runs first so
  // it throttles unauthenticated brute-force / flood attempts before any
  // routing work. Tune via PROXY_RATE_LIMIT_RPM; 0 disables it.
  app.use('/v1', createProxyRateLimiter(cfg.proxyRateLimitRpm));
  // Anthropic-compatible Messages API (`POST /v1/messages`, `/count_tokens`) for
  // Claude Code and anything else speaking the Anthropic SDK. Mounted BEFORE the
  // OpenAI router so it can content-negotiate `GET /v1/models` (Anthropic shape
  // when the caller sends `anthropic-version`, else it falls through). All other
  // paths it doesn't own fall through to the OpenAI router untouched.
  app.use('/v1', anthropicRouter);
  app.use('/v1', proxyRouter);
  // OpenAI Responses API shim (Codex CLI requires wire_api="responses"; see #96)
  app.use('/v1', responsesRouter);

  // Native Gemini wire surface for Gemini CLI and Gemini-lineage agents.
  app.use('/v1beta', createProxyRateLimiter(cfg.proxyRateLimitRpm));
  app.use('/v1beta', geminiRouter);

  // MCP server (Model Context Protocol over stateless Streamable HTTP):
  // gateway introspection tools for MCP-speaking agents. Unified-key auth,
  // like /v1 — NOT behind the dashboard session gate. Same per-IP limiter as
  // /v1 (its own bucket): both surfaces guard the same unified key, so an
  // unauthenticated brute-force must not get a free throttle-less oracle here.
  app.use('/mcp', createProxyRateLimiter(cfg.proxyRateLimitRpm));
  app.use('/mcp', mcpRouter);

  // Liveness / readiness probes for orchestrators (GET /livez, /readyz, #433).
  // Unauthenticated so a load balancer can probe them; registered before the
  // static / SPA-fallback block below so these root paths resolve to JSON
  // instead of index.html.
  app.use(statusRouter);

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler). CLIENT_DIST lets
  // embedders relocate the built dashboard (e.g. the desktop app ships it in
  // extraResources, where the __dirname-relative path can't reach).
  // Set serveStaticAssets: false in Config to skip static serving entirely
  // (e.g. in runtimes that serve assets through a different mechanism).
  if (cfg.serveStaticAssets) {
    const clientDist = cfg.clientDist
      ? path.resolve(cfg.clientDist)
      : path.resolve(__dirname, '../../client/dist');
    // Gzip the dashboard bundle (1+ MB uncompressed). Mounted HERE — after
    // every API/proxy router and the error handler — so it only wraps the
    // static-file / SPA-fallback responses below it. The /v1 and /api handlers
    // end their responses upstream and never fall through to this middleware,
    // so nothing (crucially the /v1/chat/completions SSE streams) gets buffered
    // or re-encoded by compression.
    app.use(compression());
    app.use(express.static(clientDist, {
      // Vite emits content-hashed build assets under assets/ (index-<hash>.js,
      // chunk-<hash>.js, *.css, fonts…). The URL changes whenever the bytes do,
      // so cache them for a year and mark them immutable. index.html and other
      // unhashed root entries must stay revalidated (no-cache) so a redeploy
      // propagates the new asset URLs immediately.
      setHeaders(res, filePath) {
        res.setHeader(
          'Cache-Control',
          isImmutableAsset(filePath)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        );
      },
    }));
    // SPA fallback — serve index.html for non-API routes
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path.startsWith('/v1beta/')) {
        next();
        return;
      }
      // Same no-cache policy as the statically-served index.html: SPA deep
      // links must revalidate so a redeploy propagates new asset URLs.
      res.sendFile(path.join(clientDist, 'index.html'), {
        headers: { 'Cache-Control': 'no-cache' },
      });
    });
  }

  return app;
}
