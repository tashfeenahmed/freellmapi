import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import swaggerUi from 'swagger-ui-express';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { backupRouter } from './routes/backup.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRateLimiter, keysRateLimiter, apiRateLimiter } from './middleware/rateLimit.js';
import { authRouter, requireDashboardAuth } from './auth.js';
import { throttledRefresh } from './lib/db-refresh.js';

// Load OpenAPI spec at runtime
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openapiSpec = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'docs/openapi.json'), 'utf-8')
);

export function createApp() {
  const app = express();

  // CSP intentionally disabled — the SPA bundles inline styles and the OG
  // image is loaded from the same origin; enabling helmet's default CSP
  // breaks the React build's hashed-asset loader. HSTS off because this is
  // a single-user local proxy, served over HTTP on localhost. Both should
  // stay disabled unless someone serves the proxy over HTTPS publicly
  // (which is also not a supported deployment — see README).
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  // Lazy DB refresh — debounced to max once per 500ms, non-blocking.
  // Fire-and-forget: errors are logged but don't block the request.
  app.use((req, _res, next) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/v1/')) {
      next();
      return;
    }
    throttledRefresh().catch((err) =>
      console.error('[DB] Background refresh failed:', err)
    );
    next();
  });

  // API docs (Swagger UI) — served without auth for easy access
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'FreeLLMAPI Docs',
  }));

  app.use('/api/auth', authRateLimiter, authRouter);
  app.use(requireDashboardAuth);

  // API routes — rate limited
  app.use('/api/keys', keysRateLimiter, keysRouter);
  app.use('/api/fallback', apiRateLimiter, fallbackRouter);
  app.use('/api/analytics', apiRateLimiter, analyticsRouter);
  app.use('/api/health', apiRateLimiter, healthRouter);
  app.use('/api/settings', keysRateLimiter, settingsRouter);
  app.use('/api/backup', apiRateLimiter, backupRouter);
  app.use('/api/models', apiRateLimiter, modelsRouter);

  // OpenAI-compatible proxy
  app.use('/v1', proxyRouter);

  // Health check
  app.get('/api/ping', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Error handler (for API routes)
  app.use(errorHandler);

  // Serve client static files (after API error handler)
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback — serve index.html for non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
