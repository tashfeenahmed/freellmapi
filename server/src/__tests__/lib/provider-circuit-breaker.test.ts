import { beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  acquireProviderCircuit,
  recordProviderCircuitFailure,
  recordProviderCircuitSuccess,
  releaseProviderCircuitProbe,
  resetProviderCircuitBreakers,
} from '../../lib/provider-circuit-breaker.js';

const PLATFORM = 'circuit-test';
const SCOPE = 'https://relay.example.com/v1';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  resetProviderCircuitBreakers();
});

describe('provider circuit breaker', () => {
  it('opens after repeated provider failures and admits only one half-open probe', () => {
    const now = 1_000_000;
    expect(acquireProviderCircuit(PLATFORM, SCOPE, now)).toEqual({ allowed: true, probe: false });
    recordProviderCircuitFailure(PLATFORM, SCOPE, now);
    recordProviderCircuitFailure(PLATFORM, SCOPE, now + 1);
    expect(acquireProviderCircuit(PLATFORM, SCOPE, now + 2)).toEqual({ allowed: true, probe: false });

    recordProviderCircuitFailure(PLATFORM, SCOPE, now + 3);
    expect(acquireProviderCircuit(PLATFORM, SCOPE, now + 4)).toEqual({
      allowed: false,
      retryAt: now + 3 + 30_000,
    });

    const probeAt = now + 30_003;
    expect(acquireProviderCircuit(PLATFORM, SCOPE, probeAt)).toEqual({ allowed: true, probe: true });
    expect(acquireProviderCircuit(PLATFORM, SCOPE, probeAt + 1)).toEqual({
      allowed: false,
      retryAt: probeAt + 30_000,
    });

    recordProviderCircuitFailure(PLATFORM, SCOPE, probeAt + 2);
    expect(acquireProviderCircuit(PLATFORM, SCOPE, probeAt + 3)).toEqual({
      allowed: false,
      retryAt: probeAt + 2 + 60_000,
    });
  });

  it('releases abandoned probes and closes the circuit after a successful recovery', () => {
    const now = 2_000_000;
    for (let i = 0; i < 3; i++) recordProviderCircuitFailure(PLATFORM, SCOPE, now + i);
    const probeAt = now + 30_002;
    expect(acquireProviderCircuit(PLATFORM, SCOPE, probeAt)).toEqual({ allowed: true, probe: true });

    releaseProviderCircuitProbe(PLATFORM, SCOPE, probeAt);
    expect(acquireProviderCircuit(PLATFORM, SCOPE, probeAt + 1)).toEqual({ allowed: true, probe: true });

    recordProviderCircuitSuccess(PLATFORM, SCOPE, probeAt + 1);
    expect(acquireProviderCircuit(PLATFORM, SCOPE, probeAt + 2)).toEqual({ allowed: true, probe: false });
  });

  it('keeps increasing recovery backoff after each open interval', () => {
    const now = 4_000_000;
    for (let i = 0; i < 3; i++) recordProviderCircuitFailure(PLATFORM, SCOPE, now + i);
    const firstProbeAt = now + 30_003;
    expect(acquireProviderCircuit(PLATFORM, SCOPE, firstProbeAt)).toEqual({ allowed: true, probe: true });
    recordProviderCircuitFailure(PLATFORM, SCOPE, firstProbeAt + 1);

    const secondProbeAt = firstProbeAt + 60_001;
    expect(acquireProviderCircuit(PLATFORM, SCOPE, secondProbeAt)).toEqual({ allowed: true, probe: true });
    recordProviderCircuitFailure(PLATFORM, SCOPE, secondProbeAt + 1);
    expect(acquireProviderCircuit(PLATFORM, SCOPE, secondProbeAt + 2)).toEqual({
      allowed: false,
      retryAt: secondProbeAt + 1 + 120_000,
    });
  });

  it('keeps outage state isolated by platform and endpoint scope', () => {
    const now = 3_000_000;
    for (let i = 0; i < 3; i++) recordProviderCircuitFailure(PLATFORM, SCOPE, now + i);
    expect(acquireProviderCircuit(PLATFORM, '', now + 4)).toEqual({ allowed: true, probe: false });
    expect(acquireProviderCircuit('another-platform', SCOPE, now + 4)).toEqual({ allowed: true, probe: false });
  });
});
