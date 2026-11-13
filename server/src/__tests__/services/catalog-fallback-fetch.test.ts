import { describe, it, expect, afterEach, vi } from 'vitest';
import { catalogFetch, setCatalogFallbackFetch, validateLicenseKey } from '../../services/catalog-sync.js';

// Node's fetch failing the TLS handshake surfaces as TypeError('fetch failed')
// with the real reason on .cause — what Windows desktop users hit.
function tlsFailure(): TypeError {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = Object.assign(new Error('unable to get local issuer certificate'), {
    code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  });
  return err;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  setCatalogFallbackFetch(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('catalogFetch', () => {
  it('uses Node fetch and never the fallback when Node fetch works', async () => {
    const nodeFetch = vi.fn(async () => json({ ok: true }));
    const fallback = vi.fn(async () => json({ ok: 'fallback' }));
    vi.stubGlobal('fetch', nodeFetch);
    setCatalogFallbackFetch(fallback);

    const res = await catalogFetch('https://catalog.test/v1/latest');
    expect(await res.json()).toEqual({ ok: true });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('retries once through the fallback when Node fetch fails at the network level', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw tlsFailure(); }));
    const fallback = vi.fn(async () => json({ ok: 'fallback' }));
    setCatalogFallbackFetch(fallback);

    const init = { method: 'POST', body: '{}' };
    const res = await catalogFetch('https://catalog.test/v1/license/activate', init);
    expect(await res.json()).toEqual({ ok: 'fallback' });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith('https://catalog.test/v1/license/activate', init);
    expect(String((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]))
      .toContain('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  });

  it('rethrows without a fallback registered (server and Docker installs)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw tlsFailure(); }));
    await expect(catalogFetch('https://catalog.test/v1/latest')).rejects.toThrow('fetch failed');
  });

  it('does not retry a request that timed out', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError'); }));
    const fallback = vi.fn(async () => json({}));
    setCatalogFallbackFetch(fallback);

    await expect(catalogFetch('https://catalog.test/v1/latest', { signal: controller.signal })).rejects.toThrow();
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('validateLicenseKey', () => {
  it('activates through the fallback when Node fetch cannot reach the service', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw tlsFailure(); }));
    setCatalogFallbackFetch(async () => json({ valid: true, plan: 'lifetime', status: 'active' }));

    await expect(validateLicenseKey('fla_TESTKEY')).resolves.toMatchObject({ valid: true, plan: 'lifetime' });
  });

  it('returns null (unreachable) and logs the cause when both stacks fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw tlsFailure(); }));
    setCatalogFallbackFetch(async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); });

    await expect(validateLicenseKey('fla_TESTKEY')).resolves.toBeNull();
    expect(warn.mock.calls.some(c => String(c[0]).includes('license activation unreachable: net::ERR_CONNECTION_REFUSED'))).toBe(true);
  });
});
