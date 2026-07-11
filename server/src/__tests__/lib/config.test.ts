import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig } from '../../lib/config.js';

const ENV_KEYS = ['PORT', 'HOST', 'FREEAPI_DB_PATH', 'DASHBOARD_ORIGINS', 'CLIENT_DIST', 'PROXY_RATE_LIMIT_RPM', 'NODE_ENV'];

afterEach(() => {
  ENV_KEYS.forEach(k => delete process.env[k]);
});

describe('loadConfig', () => {
  it('returns sensible defaults when no env vars are set', () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(3001);
    expect(cfg.host).toBe('::');
    expect(cfg.dbPath).toBeNull();
    expect(cfg.dashboardOrigins).toEqual([]);
    expect(cfg.clientDist).toBeNull();
    expect(cfg.proxyRateLimitRpm).toBe(120);
    expect(cfg.serveStaticAssets).toBe(true);
  });

  it('reads PORT and HOST from env', () => {
    process.env.PORT = '8080';
    process.env.HOST = '0.0.0.0';
    const cfg = loadConfig();
    expect(cfg.port).toBe('8080');
    expect(cfg.host).toBe('0.0.0.0');
  });

  it('parses DASHBOARD_ORIGINS as a comma-separated list', () => {
    process.env.DASHBOARD_ORIGINS = 'http://localhost:3000, http://example.com , ';
    const cfg = loadConfig();
    expect(cfg.dashboardOrigins).toEqual(['http://localhost:3000', 'http://example.com']);
  });

  it('reads CLIENT_DIST from env', () => {
    process.env.CLIENT_DIST = '/opt/client/dist';
    const cfg = loadConfig();
    expect(cfg.clientDist).toBe('/opt/client/dist');
  });

  it('reads FREEAPI_DB_PATH from env', () => {
    process.env.FREEAPI_DB_PATH = '/data/freeapi.db';
    expect(loadConfig().dbPath).toBe('/data/freeapi.db');
  });

  it('parses PROXY_RATE_LIMIT_RPM as a number', () => {
    process.env.PROXY_RATE_LIMIT_RPM = '60';
    expect(loadConfig().proxyRateLimitRpm).toBe(60);
  });

  it('falls back to default RPM for invalid PROXY_RATE_LIMIT_RPM', () => {
    process.env.PROXY_RATE_LIMIT_RPM = 'not-a-number';
    expect(loadConfig().proxyRateLimitRpm).toBe(120);
    process.env.PROXY_RATE_LIMIT_RPM = '-5';
    expect(loadConfig().proxyRateLimitRpm).toBe(120);
  });

  it('accepts 0 to disable rate limiting', () => {
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    expect(loadConfig().proxyRateLimitRpm).toBe(0);
  });

  it('reads NODE_ENV from env', () => {
    process.env.NODE_ENV = 'production';
    expect(loadConfig().nodeEnv).toBe('production');
  });
});
