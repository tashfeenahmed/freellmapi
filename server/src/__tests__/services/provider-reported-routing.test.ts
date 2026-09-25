import { it, expect } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { newFallbackState, recordRetryableFailure, fallbackRoutingTokens } from '../../lib/fallback-loop.js';
it('does not dispatch to a window smaller than provider input plus output reserve', () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:'); const db = getDb(); setRoutingStrategy('priority');
  const model = db.prepare("SELECT id FROM models WHERE platform = 'groq' LIMIT 1").get() as any;
  db.prepare('UPDATE models SET enabled = 0 WHERE id != ?').run(model.id);
  db.prepare('UPDATE models SET context_window = 24000, tpm_limit = NULL, rpm_limit = NULL, rpd_limit = NULL, tpd_limit = NULL WHERE id = ?').run(model.id);
  const {encrypted, iv, authTag} = encrypt('synthetic-test-key');
  db.prepare("INSERT INTO api_keys (platform,label,encrypted_key,iv,auth_tag,status,enabled) VALUES ('groq','review',?,?,?,'healthy',1)").run(encrypted,iv,authTag);
  const state = newFallbackState();
  const error = Object.assign(new Error('Cloudflare API error 400: your prompt contains at least 23745 input tokens, for a total of at least 24001 tokens'), {status: 400});
  recordRetryableFailure({platform: 'cloudflare', modelId: 'failed-model', modelDbId: -1, keyId: -1} as any, error, state);
  expect(state.observedInputTokens).toBe(23745);
  expect(fallbackRoutingTokens(state, 4000, 256)).toBe(24001);
  expect(() => routeRequest(fallbackRoutingTokens(state, 4000, 256), undefined, undefined, false, false, undefined, undefined, false, undefined, 256)).toThrow();
  expect(() => routeRequest(fallbackRoutingTokens(state, 4000, 255), undefined, undefined, false, false, undefined, undefined, false, undefined, 255)).not.toThrow();
});
it('adds the output reserve only to input observations', () => {
  const state = newFallbackState();
  expect(fallbackRoutingTokens(state, 4000, 256)).toBe(4000);
  state.observedTotalTokens = 24001;
  expect(fallbackRoutingTokens(state, 4000, 256)).toBe(24001);
  state.observedInputTokens = 24000;
  expect(fallbackRoutingTokens(state, 4000, 256)).toBe(24256);
});
