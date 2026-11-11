// A provider-side "cannot serve this request" 400 (#1876) fails over to the next
// route without benching the key: the same key still serves ordinary requests.
import { describe, it, expect, beforeAll } from 'vitest';
import { runFallbackLoop, newFallbackState, type FallbackHooks } from '../../lib/fallback-loop.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { providerRequestError } from '../../providers/base.js';
import { isOnCooldown, resetKeyLocalityCache } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

let keyA = 0, keyB = 0;
function insertKey(platform: string, label: string): number {
  const { encrypted, iv, authTag } = encrypt(`test-${label}`);
  return Number(getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, 'healthy', 1)`).run(platform, label, encrypted, iv, authTag).lastInsertRowid);
}
const route = (platform: string, keyId: number, modelId: string, modelDbId: number): RouteResult =>
  ({ provider: {} as any, modelId, modelDbId, apiKey: 'k', keyId, platform, displayName: modelId, rpdLimit: null, tpdLimit: null } as RouteResult);
const hooks = (o: Partial<FallbackHooks>): FallbackHooks => ({ state: newFallbackState(), timeBudgetMs: 0, route: () => { throw new Error('unused'); }, dispatch: async () => 'done', logFailure: () => {}, onFatal: () => {}, onRoutingExhausted: () => {}, onExhausted: () => {}, ...o });

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64); process.env.NODE_ENV = 'test'; initDb(':memory:');
  keyA = insertKey('gizmo', 'gizmo'); keyB = insertKey('groq', 'groq'); resetKeyLocalityCache();
});

describe('provider request rejection', () => {
  for (const kind of ['request', 'model'] as const) {
    it(`a ${kind} rejection fails over and leaves the key off cooldown`, async () => {
      const candidates = [route('gizmo', keyA, 'gizmo-chat', 1), route('groq', keyB, 'llama', 2)];
      let i = 0; const served: string[] = []; let fatal = false;
      await runFallbackLoop(hooks({
        maxRetries: 3,
        route: () => candidates[i++] ?? (() => { throw Object.assign(new Error('empty'), { status: 429 }); })(),
        dispatch: async (r) => { if (r.platform === 'gizmo') throw providerRequestError('Gizmo chat supports text only, not tool calling', kind); served.push(r.platform); return 'done' as const; },
        onFatal: () => { fatal = true; },
      }));
      expect(fatal).toBe(false);
      expect(served).toEqual(['groq']);
      expect(isOnCooldown('gizmo', 'gizmo-chat', keyA)).toBe(false);
    });
  }
});
