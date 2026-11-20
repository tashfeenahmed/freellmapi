import dns from 'node:dns';
import { vi } from 'vitest';

// The URL guard resolves a hostname before every custom-provider or media
// download request and blocks the request when the name does not resolve
// (#1875). Tests use made-up hosts (relay.example, cdn.example.test), so answer
// every lookup with a public documentation address (TEST-NET-3) instead of
// asking a real resolver, which is slow on NXDOMAIN in CI and fails offline.
// Call it from a beforeEach: vi.restoreAllMocks() removes the spy.
export function stubPublicDns(address = '203.0.113.10'): void {
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address, family: 4 }] as any);
}
