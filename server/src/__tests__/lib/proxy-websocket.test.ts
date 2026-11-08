import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { applyProxyUrl, applyProxyEnabled, applyProxyMode, applyProxyBypass, openProviderWebSocket, withKeyProxy } from '../../lib/proxy.js';

const { constructor } = vi.hoisted(() => ({ constructor: vi.fn() }));
vi.mock('undici', () => ({ WebSocket: class { constructor(...args: unknown[]) { constructor(...args); } }, ProxyAgent: class { close() {} } }));
vi.mock('node:child_process', async original => ({ ...(await original<Record<string, unknown>>()), execFileSync: () => '' }));
beforeEach(() => {
  initDb(':memory:'); constructor.mockClear();
  for (const name of ['PROXY_URL', 'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'PROXY_REQUIRED_PLATFORMS']) { vi.stubEnv(name, ''); vi.stubEnv(name.toLowerCase(), ''); }
  applyProxyEnabled(true); applyProxyBypass(''); applyProxyUrl(''); applyProxyMode('forward');
});
afterEach(() => { vi.unstubAllEnvs(); getDb().close(); });
const url = 'wss://stt.api.rime.ai/ws', options = { protocols: ['rime.v1.json'], headers: { Authorization: 'Bearer test' } };
it('keeps auth in the upgrade headers with no proxy configured', async () => {
  await openProviderWebSocket(url, 'rime', options); expect(constructor).toHaveBeenCalledWith(url, options);
});
it('uses a configured HTTP CONNECT dispatcher', async () => {
  applyProxyUrl('http://proxy.example:8080'); await openProviderWebSocket(url, 'rime', options);
  expect(constructor).toHaveBeenCalledWith(url, { ...options, dispatcher: expect.any(Object) });
});
it('honors a per-key HTTP proxy ahead of a global Fetch Relay', async () => {
  applyProxyUrl('https://relay.example'); applyProxyMode('fetch-relay');
  await withKeyProxy('http://key-proxy.example:8080', () => openProviderWebSocket(url, 'rime', options));
  expect(constructor).toHaveBeenCalledWith(url, { ...options, dispatcher: expect.any(Object) });
});
it.each(['fetch-relay', 'socks'])('fails closed for unsupported %s rather than bypassing it', async mode => {
  applyProxyUrl(mode === 'socks' ? 'socks5://localhost:1080' : 'https://relay.example');
  if (mode === 'fetch-relay') applyProxyMode('fetch-relay');
  await expect(openProviderWebSocket(url, 'rime', options)).rejects.toThrow(); expect(constructor).not.toHaveBeenCalled();
});
it('does not bypass a required proxy when disabled', async () => {
  vi.stubEnv('PROXY_REQUIRED_PLATFORMS', 'rime'); applyProxyEnabled(false);
  await expect(openProviderWebSocket(url, 'rime', options)).rejects.toMatchObject({ code: 'PROXY_REQUIRED_UNAVAILABLE' }); expect(constructor).not.toHaveBeenCalled();
});
