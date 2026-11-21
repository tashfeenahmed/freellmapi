import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import {
  learnOutputCapFromError,
  learnedOutputCap,
  resetLearnedOutputCapCache,
  resetLearnedOutputCaps,
} from '../../lib/output-cap.js';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  resetLearnedOutputCaps();
});

describe('persisted learned output caps', () => {
  it('reloads a learned ceiling from the database after the in-process cache is cleared', () => {
    const route = { platform: 'groq', modelId: 'persisted-cap-test' };
    const err = Object.assign(new Error('max_tokens must be at most 32768'), { status: 400 });
    expect(learnOutputCapFromError(route, err)).toBe(32768);

    resetLearnedOutputCapCache();
    expect(learnedOutputCap(route.platform, route.modelId)).toBe(32768);
  });

  it('keeps persisted ceilings isolated by endpoint scope', () => {
    const relayA = { platform: 'custom', modelId: 'shared-model', endpointScope: 'https://a.example.com/v1' };
    const relayB = { ...relayA, endpointScope: 'https://b.example.com/v1' };
    const err = Object.assign(new Error('max_tokens must be at most 8192'), { status: 400 });
    learnOutputCapFromError(relayA, err);

    resetLearnedOutputCapCache();
    expect(learnedOutputCap(relayA.platform, relayA.modelId, relayA.endpointScope)).toBe(8192);
    expect(learnedOutputCap(relayB.platform, relayB.modelId, relayB.endpointScope)).toBeUndefined();
  });

  it('relearns expired ceilings instead of preserving stale provider limits forever', () => {
    const route = { platform: 'groq', modelId: 'expired-cap-test' };
    const err = Object.assign(new Error('max_tokens must be at most 32768'), { status: 400 });
    learnOutputCapFromError(route, err);
    getDb().prepare(`
      UPDATE learned_output_caps SET learned_at_ms = ?
      WHERE platform = ? AND model_id = ? AND endpoint_scope = ''
    `).run(Date.now() - 91 * 24 * 60 * 60 * 1000, route.platform, route.modelId);
    resetLearnedOutputCapCache();

    expect(learnedOutputCap(route.platform, route.modelId)).toBeUndefined();
    expect(learnOutputCapFromError(route, Object.assign(
      new Error('max_tokens must be at most 65536'),
      { status: 400 },
    ))).toBe(65536);
    expect(learnedOutputCap(route.platform, route.modelId)).toBe(65536);
  });
});
