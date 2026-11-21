import fs from 'node:fs';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../server/src/env.js', () => ({}));

const { trustSystemCertificates, isCertificateOutOfDate } = await import('../server-host.js');

// #1373: antivirus HTTPS scanning and corporate TLS inspection re-sign traffic
// with a root installed in the OS store. The desktop app must trust that store
// on top of Node's bundled roots, or every provider call is a bare "fetch failed".
describe('trustSystemCertificates', () => {
  it('adds the OS store to the default roots without duplicates', () => {
    const setDefaultCACertificates = vi.fn();
    const getCACertificates = vi.fn((type?: string) => (type === 'system' ? ['AV-ROOT', 'SHARED'] : ['BUNDLED', 'SHARED']));
    expect(trustSystemCertificates({ getCACertificates, setDefaultCACertificates } as any)).toBe(2);
    expect(setDefaultCACertificates).toHaveBeenCalledWith(['BUNDLED', 'SHARED', 'AV-ROOT']);
  });

  it('leaves the defaults alone when the OS store is empty', () => {
    const setDefaultCACertificates = vi.fn();
    const getCACertificates = vi.fn((type?: string) => (type === 'system' ? [] : ['BUNDLED']));
    expect(trustSystemCertificates({ getCACertificates, setDefaultCACertificates } as any)).toBe(0);
    expect(setDefaultCACertificates).not.toHaveBeenCalled();
  });

  it('is a no-op on a runtime without the APIs', () => {
    expect(trustSystemCertificates({} as any)).toBe(0);
  });

  it('never throws when the OS store cannot be read', () => {
    const getCACertificates = vi.fn(() => { throw new Error('keychain locked'); });
    expect(trustSystemCertificates({ getCACertificates, setDefaultCACertificates: vi.fn() } as any)).toBe(0);
  });
});

// #2041: Windows hands Node its cached intermediates too, with no date check.
// The ISRG Root X2 cross-signed by X1 (expired 15 Sep 2025) in that list made
// Electron's BoringSSL build Root YE chains through it → CERT_HAS_EXPIRED.
const EXPIRED_X2_CROSS = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/isrg-root-x2-cross-signed-expired-2025.pem', import.meta.url)),
  'utf8',
);
const ISRG_ROOT_X1 = tls.rootCertificates.find((pem) => /CN\s*=\s*ISRG Root X1/.test(new X509Certificate(pem).subject))!;
const NOW = Date.parse('2026-11-21T00:00:00Z');

describe('isCertificateOutOfDate', () => {
  it('flags a certificate past its notAfter', () => {
    expect(isCertificateOutOfDate(EXPIRED_X2_CROSS, NOW)).toBe(true);
    expect(isCertificateOutOfDate(EXPIRED_X2_CROSS, Date.parse('2024-01-01T00:00:00Z'))).toBe(false);
  });

  it('flags a certificate before its notBefore', () => {
    expect(isCertificateOutOfDate(ISRG_ROOT_X1, Date.parse('2010-01-01T00:00:00Z'))).toBe(true);
    expect(isCertificateOutOfDate(ISRG_ROOT_X1, NOW)).toBe(false);
  });

  it('keeps anything it cannot parse', () => {
    expect(isCertificateOutOfDate('not a certificate', NOW)).toBe(false);
  });
});

describe('trustSystemCertificates date filter', () => {
  it('drops expired certificates from the OS store', () => {
    const setDefaultCACertificates = vi.fn();
    const getCACertificates = vi.fn((type?: string) => (type === 'system' ? [EXPIRED_X2_CROSS, 'AV-ROOT'] : [ISRG_ROOT_X1]));
    expect(trustSystemCertificates({ getCACertificates, setDefaultCACertificates } as any, NOW)).toBe(1);
    expect(setDefaultCACertificates).toHaveBeenCalledWith([ISRG_ROOT_X1, 'AV-ROOT']);
  });

  it('drops expired certificates that came in through the defaults (NODE_EXTRA_CA_CERTS)', () => {
    const setDefaultCACertificates = vi.fn();
    const getCACertificates = vi.fn((type?: string) => (type === 'system' ? ['AV-ROOT'] : [ISRG_ROOT_X1, EXPIRED_X2_CROSS]));
    trustSystemCertificates({ getCACertificates, setDefaultCACertificates } as any, NOW);
    expect(setDefaultCACertificates).toHaveBeenCalledWith([ISRG_ROOT_X1, 'AV-ROOT']);
  });

  it('still installs the bundled roots when every OS certificate is expired', () => {
    const setDefaultCACertificates = vi.fn();
    const getCACertificates = vi.fn((type?: string) => (type === 'system' ? [EXPIRED_X2_CROSS] : [ISRG_ROOT_X1]));
    expect(trustSystemCertificates({ getCACertificates, setDefaultCACertificates } as any, NOW)).toBe(0);
    expect(setDefaultCACertificates).toHaveBeenCalledWith([ISRG_ROOT_X1]);
  });

  // Electron's Node has tls.getCACertificates; the plain Node that runs desktop
  // tests in CI may not (it landed in Node 22.15 / 23.2).
  const hasCaApi = typeof (tls as { getCACertificates?: unknown }).getCACertificates === 'function'
    && typeof (tls as { setDefaultCACertificates?: unknown }).setDefaultCACertificates === 'function';

  it.skipIf(!hasCaApi)('works on the real tls module and keeps every bundled root', () => {
    const before = tls.getCACertificates('default');
    try {
      trustSystemCertificates(tls, NOW);
      const after = tls.getCACertificates('default');
      // Node re-serialises the PEMs it stores, so compare fingerprints.
      const fp = (pem: string) => new X509Certificate(pem).fingerprint256;
      const afterFps = new Set(after.map(fp));
      for (const pem of before.filter((p) => !isCertificateOutOfDate(p, NOW))) expect(afterFps.has(fp(pem))).toBe(true);
      expect(after.some((pem) => isCertificateOutOfDate(pem, NOW))).toBe(false);
    } finally {
      tls.setDefaultCACertificates(before);
    }
  });
});
