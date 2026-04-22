import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { countUsers } from './db/index.js';
import { keysRouter } from './routes/keys.js';
import { modelsRouter } from './routes/models.js';
import { proxyRouter } from './routes/proxy.js';
import { fallbackRouter } from './routes/fallback.js';
import { analyticsRouter } from './routes/analytics.js';
import { healthRouter } from './routes/health.js';
import { settingsRouter } from './routes/settings.js';
import { authRouter } from './routes/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { attachSession, requireAuth } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(
    cors({
      origin: true,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(attachSession);

  // Public API — auth
  app.use('/api/auth', authRouter);

  // Protected API
  app.use('/api/keys', requireAuth, keysRouter);
  app.use('/api/models', requireAuth, modelsRouter);
  app.use('/api/fallback', requireAuth, fallbackRouter);
  app.use('/api/analytics', requireAuth, analyticsRouter);
  app.use('/api/health', requireAuth, healthRouter);
  app.use('/api/settings', requireAuth, settingsRouter);

  // OpenAI-compatible proxy (session not required; Bearer on /v1)
  app.use('/v1', proxyRouter);

  app.get('/api/ping', requireAuth, (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use(errorHandler);

  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      next();
      return;
    }

    const isPublicSpa =
      req.path === '/login' ||
      req.path === '/setup' ||
      req.path.startsWith('/login/') ||
      req.path.startsWith('/setup/');
    const isAssetLike = /\.[a-zA-Z0-9]{1,8}$/.test(req.path);

    if (isAssetLike) {
      res.status(404).end();
      return;
    }
    if (isPublicSpa) {
      res.sendFile(path.join(clientDist, 'index.html'));
      return;
    }
    if (req.session.userId == null) {
      const dest = countUsers() === 0 ? '/setup' : '/login';
      res.redirect(302, dest);
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
