import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../server/src/env.js', () => ({}));

const { trustSystemCertificates } = await import('../server-host.js');

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
