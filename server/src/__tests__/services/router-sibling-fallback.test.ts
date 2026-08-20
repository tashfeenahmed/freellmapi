import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { routeRequest, setRoutingStrategy, type ChainRow } from '../../services/router.js';
import { encrypt } from '../../lib/crypto.js';

// Same-model cross-provider fallback: when a client pins an explicit model
// and that model_id is also served by other enabled platforms, those sibling
// rows should be tried immediately after the pinned one once it's ruled out
// — ahead of an unrelated model that would otherwise win on priority/score.

function addKey(platform: string): void {
  const { encrypted, iv, authTag } = encrypt(`${platform}-secret`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, platform, encrypted, iv, authTag);
}

function row(overrides: Partial<ChainRow>): ChainRow {
  return {
    model_db_id: 0,
    priority: 0,
    enabled: 1,
    platform: '',
    model_id: '',
    display_name: '',
    intelligence_rank: 50,
    size_label: 'medium',
    monthly_token_budget: '',
    rpm_limit: null,
    rpd_limit: null,
    tpm_limit: null,
    tpd_limit: null,
    supports_vision: 0,
    supports_tools: 0,
    context_window: null,
    key_id: null,
    endpoint_scope: '',
    ...overrides,
  };
}

describe('same-model cross-provider fallback', () => {
  const PINNED_ID = 9001;
  const UNRELATED_ID = 9002;
  const SIBLING_ID = 9003;

  // Base priority order (no pin involved): pinned, then the unrelated model
  // (better priority than the sibling), then the sibling last. This is the
  // order a failed pin would fall through to WITHOUT the patch.
  const chain: ChainRow[] = [
    row({ model_db_id: PINNED_ID, priority: 1, platform: 'groq', model_id: 'shared-model' }),
    row({ model_db_id: UNRELATED_ID, priority: 2, platform: 'google', model_id: 'different-model' }),
    row({ model_db_id: SIBLING_ID, priority: 3, platform: 'cerebras', model_id: 'shared-model' }),
  ];

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    getDb().prepare('DELETE FROM api_keys').run();
    setRoutingStrategy('priority');
    addKey('groq');
    addKey('google');
    addKey('cerebras');
  });

  it('routes to the pinned model first', () => {
    const route = routeRequest(1000, undefined, PINNED_ID, false, false, undefined, chain);
    expect(route.platform).toBe('groq');
    route.release?.();
  });

  it('falls through to the same-model sibling on another platform, ahead of a better-priority unrelated model', () => {
    const route = routeRequest(1000, undefined, PINNED_ID, false, false, new Set([PINNED_ID]), chain);
    expect(route.platform).toBe('cerebras');
    expect(route.modelId).toBe('shared-model');
    route.release?.();
  });

  it('falls through to the unrelated model once both the pin and its sibling are ruled out', () => {
    const route = routeRequest(1000, undefined, PINNED_ID, false, false, new Set([PINNED_ID, SIBLING_ID]), chain);
    expect(route.platform).toBe('google');
    route.release?.();
  });

  it('is a no-op when the pinned model has no siblings', () => {
    const noSiblingChain: ChainRow[] = [
      row({ model_db_id: PINNED_ID, priority: 1, platform: 'groq', model_id: 'solo-model' }),
      row({ model_db_id: UNRELATED_ID, priority: 2, platform: 'google', model_id: 'different-model' }),
    ];
    const route = routeRequest(1000, undefined, PINNED_ID, false, false, new Set([PINNED_ID]), noSiblingChain);
    expect(route.platform).toBe('google');
    route.release?.();
  });
});
