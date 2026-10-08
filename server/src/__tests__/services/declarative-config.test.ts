import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, getSetting, setSetting } from '../../db/index.js';
import { applyDeclarativeConfig, applyDeclarativeConfigFromEnv, activateConfiguredLicense } from '../../services/declarative-config.js';
import { getRoutingStrategy } from '../../services/router.js';
import { userCount, verifyCredentials } from '../../services/auth.js';
import { SETTING_LICENSE_KEY } from '../../services/catalog-sync.js';

const ORIGINAL_CONFIG_JSON = process.env.FREEAPI_CONFIG_JSON;
const ORIGINAL_CONFIG_PATH = process.env.FREEAPI_CONFIG_PATH;

function restoreEnv() {
  if (ORIGINAL_CONFIG_JSON === undefined) delete process.env.FREEAPI_CONFIG_JSON;
  else process.env.FREEAPI_CONFIG_JSON = ORIGINAL_CONFIG_JSON;
  if (ORIGINAL_CONFIG_PATH === undefined) delete process.env.FREEAPI_CONFIG_PATH;
  else process.env.FREEAPI_CONFIG_PATH = ORIGINAL_CONFIG_PATH;
}

describe('declarative config import', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    delete process.env.FREEAPI_CONFIG_JSON;
    delete process.env.FREEAPI_CONFIG_PATH;
    getDb().prepare('DELETE FROM api_keys').run();
  });

  afterEach(() => restoreEnv());

  it('applies keys, custom providers, model overrides, fallback order and routing', () => {
    const target = getDb().prepare(`
      SELECT platform, model_id FROM models
       WHERE platform = 'groq' AND key_id IS NULL
       ORDER BY id LIMIT 1
    `).get() as { platform: string; model_id: string };

    const result = applyDeclarativeConfig({
      keys: [{ platform: 'groq', key: 'gsk_config_key', label: 'config' }],
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9123/v1',
        apiKey: 'local-key',
        label: 'Local config',
        models: [{ model: 'local-chat', displayName: 'Local Chat', supportsTools: true, contextWindow: 32000 }],
      }],
      models: [{
        platform: target.platform,
        modelId: target.model_id,
        displayName: 'Config Display',
        supportsTools: true,
        contextWindow: 654321,
      }],
      fallback: [{ platform: target.platform, modelId: target.model_id, priority: 1, enabled: false }],
      routing: { strategy: 'custom', weights: { reliability: 3, speed: 1, intelligence: 2 } },
    });

    expect(result).toMatchObject({ applied: true, keys: 1, customModels: 1, models: 1, fallback: 1, routing: true });
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'").get() as { n: number }).n).toBe(1);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number }).n).toBe(1);
    expect(getDb().prepare(`
      SELECT display_name, supports_tools, context_window FROM models
       WHERE platform = 'custom' AND model_id = 'local-chat'
    `).get()).toEqual({ display_name: 'Local Chat', supports_tools: 1, context_window: 32000 });

    const model = getDb().prepare(`
      SELECT m.display_name, m.supports_tools, m.context_window, fc.priority, fc.enabled AS fallback_enabled
        FROM models m
        JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.platform = ? AND m.model_id = ?
    `).get(target.platform, target.model_id) as {
      display_name: string;
      supports_tools: number;
      context_window: number;
      priority: number;
      fallback_enabled: number;
    };
    expect(model).toEqual({
      display_name: 'Config Display',
      supports_tools: 1,
      context_window: 654321,
      priority: 1,
      fallback_enabled: 0,
    });
    expect(getDb().prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
      .get(target.platform, target.model_id)).toBeDefined();
    expect(getRoutingStrategy()).toBe('custom');

    applyDeclarativeConfig({
      models: [{ platform: target.platform, modelId: target.model_id, displayName: 'Edited Again' }],
    });
    expect((getDb().prepare(`
      SELECT fc.enabled AS fallback_enabled
        FROM models m
        JOIN fallback_config fc ON fc.model_db_id = m.id
       WHERE m.platform = ? AND m.model_id = ?
    `).get(target.platform, target.model_id) as { fallback_enabled: number }).fallback_enabled).toBe(0);
  });

  it('applies inline JSON from FREEAPI_CONFIG_JSON idempotently', () => {
    process.env.FREEAPI_CONFIG_JSON = JSON.stringify({
      keys: [{ platform: 'groq', key: 'gsk_config_key', label: 'config' }],
    });

    expect(applyDeclarativeConfigFromEnv().applied).toBe(true);
    expect(applyDeclarativeConfigFromEnv().applied).toBe(true);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq' AND label = 'config'").get() as { n: number }).n).toBe(1);
  });

  // #600: pollinations lost `keyless: true` in #573, so a legacy declarative
  // config with a keyless-era pollinations entry (no `key`) used to throw at
  // boot and brick the install. Missing-key entries must now degrade to a
  // per-entry skip + warning instead of killing the apply.
  it('skips a legacy keyless entry without a key, warns, and still applies the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = applyDeclarativeConfig({
        keys: [
          { platform: 'pollinations' },
          { platform: 'groq', key: 'gsk_config_key', label: 'config' },
        ],
      });
      expect(result.applied).toBe(true);
      expect(result.keys).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('pollinations');
      expect(result.warnings[0]).toContain('enter.pollinations.ai');
      expect(result.warnings[0]).toContain('entry skipped');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('pollinations'));
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'pollinations'").get() as { n: number }).n).toBe(0);
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'").get() as { n: number }).n).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('boot apply (FromEnv) survives a legacy keyless pollinations entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.FREEAPI_CONFIG_JSON = JSON.stringify({
        keys: [
          { platform: 'pollinations', label: 'legacy' },
          { platform: 'groq', key: 'gsk_config_key', label: 'config' },
        ],
      });
      expect(() => applyDeclarativeConfigFromEnv()).not.toThrow();
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'").get() as { n: number }).n).toBe(1);
      expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'pollinations'").get() as { n: number }).n).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('still applies a pollinations entry that has a key', () => {
    const result = applyDeclarativeConfig({
      keys: [{ platform: 'pollinations', key: 'pk_live_abc', label: 'config' }],
    });
    expect(result.keys).toBe(1);
    expect(result.warnings).toHaveLength(0);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'pollinations'").get() as { n: number }).n).toBe(1);
  });

  it('generic missing-key skip covers any non-keyless platform, with a platform-named warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = applyDeclarativeConfig({
        keys: [{ platform: 'groq' }],
      });
      expect(result.keys).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('groq');
      expect(result.warnings[0]).toContain('entry skipped');
    } finally {
      warn.mockRestore();
    }
  });

  it('a keyless platform entry without a key still applies its sentinel row', () => {
    const result = applyDeclarativeConfig({
      keys: [{ platform: 'kilo', label: 'config' }],
    });
    expect(result.keys).toBe(1);
    expect(result.warnings).toHaveLength(0);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'kilo'").get() as { n: number }).n).toBe(1);
  });

  it('genuinely malformed config still fails loudly', () => {
    expect(() => applyDeclarativeConfig({ keys: [{ platform: 'groq' }], nonsense: true }))
      .toThrow(/invalid declarative config/);
    expect(() => applyDeclarativeConfig({ keys: [{ platform: 'unknown-platform', key: 'x' }] }))
      .toThrow(/unknown provider platform/);
    process.env.FREEAPI_CONFIG_JSON = '{ not json';
    expect(() => applyDeclarativeConfigFromEnv()).toThrow();
  });
});

// Per-endpoint identity (#651): two relays can hold the same model id, so a
// declarative `models:` or `fallback:` entry naming only (platform, modelId) is
// ambiguous for platform 'custom'. Patching whichever row SQLite returned first
// would silently edit the wrong relay, so the entry has to say which endpoint
// it means.
describe('declarative config with two relays serving one model id', () => {
  const RELAY_A = 'http://127.0.0.1:9301/v1';
  const RELAY_B = 'http://127.0.0.1:9302/v1';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    delete process.env.FREEAPI_CONFIG_JSON;
    delete process.env.FREEAPI_CONFIG_PATH;
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
    db.prepare("DELETE FROM profile_models WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
    db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
    db.prepare('DELETE FROM api_keys').run();
    applyDeclarativeConfig({
      customProviders: [
        { baseUrl: RELAY_A, apiKey: 'sk-a', label: 'Relay A', models: ['shared-model'] },
        { baseUrl: RELAY_B, apiKey: 'sk-b', label: 'Relay B', models: ['shared-model'] },
      ],
    });
  });

  afterEach(() => restoreEnv());

  function rowOn(scope: string) {
    return getDb().prepare(
      "SELECT id, display_name, enabled FROM models WHERE platform = 'custom' AND model_id = 'shared-model' AND endpoint_scope = ?",
    ).get(scope) as { id: number; display_name: string; enabled: number };
  }

  it('refuses an ambiguous model edit instead of patching an arbitrary relay', () => {
    expect(() => applyDeclarativeConfig({
      models: [{ platform: 'custom', modelId: 'shared-model', displayName: 'Renamed' }],
    })).toThrow(/more than one endpoint/i);

    // Nothing was written — the whole apply is one transaction.
    expect(rowOn(RELAY_A).display_name).toBe('shared-model');
    expect(rowOn(RELAY_B).display_name).toBe('shared-model');
  });

  it('edits exactly the endpoint the entry names', () => {
    applyDeclarativeConfig({
      models: [{ platform: 'custom', modelId: 'shared-model', endpoint: RELAY_B, displayName: 'Only B' }],
    });

    expect(rowOn(RELAY_A).display_name).toBe('shared-model');
    expect(rowOn(RELAY_B).display_name).toBe('Only B');
  });

  it('rejects an endpoint that serves no such model', () => {
    expect(() => applyDeclarativeConfig({
      models: [{ platform: 'custom', modelId: 'shared-model', endpoint: 'http://127.0.0.1:9999/v1', displayName: 'x' }],
    })).toThrow(/no custom endpoint/i);
  });

  it('applies a fallback entry to the named endpoint only', () => {
    const before = getDb().prepare('SELECT priority FROM fallback_config WHERE model_db_id = ?')
      .get(rowOn(RELAY_A).id) as { priority: number };

    applyDeclarativeConfig({
      fallback: [{ platform: 'custom', modelId: 'shared-model', endpoint: RELAY_B, priority: 3 }],
    });

    expect((getDb().prepare('SELECT priority FROM fallback_config WHERE model_db_id = ?')
      .get(rowOn(RELAY_B).id) as { priority: number }).priority).toBe(3);
    expect((getDb().prepare('SELECT priority FROM fallback_config WHERE model_db_id = ?')
      .get(rowOn(RELAY_A).id) as { priority: number }).priority).toBe(before.priority);
  });

  it('leaves a single-endpoint declaration working with no endpoint field', () => {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config WHERE model_db_id = ?").run(rowOn(RELAY_B).id);
    db.prepare("DELETE FROM profile_models WHERE model_db_id = ?").run(rowOn(RELAY_B).id);
    db.prepare("DELETE FROM models WHERE platform = 'custom' AND endpoint_scope = ?").run(RELAY_B);
    applyDeclarativeConfig({
      models: [{ platform: 'custom', modelId: 'shared-model', displayName: 'Solo' }],
    });
    expect(rowOn(RELAY_A).display_name).toBe('Solo');
  });
});

// admin + license: the two declarative fields that touch the dashboard account
// and the Premium catalog feed. The admin entry must only ever create the
// FIRST account — once a user exists it degrades to a warning so a config
// file can never take over a claimed install. The license entry goes through
// the same validate-then-store contract as POST /api/premium/key.
describe('declarative config admin', () => {
  beforeEach(() => {
    getDb().prepare('DELETE FROM users').run();
    getDb().prepare('DELETE FROM sessions').run();
  });

  it('creates the first dashboard account only while no user exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = applyDeclarativeConfig({
      admin: { email: 'Ops@Example.com', password: 'correct horse battery' },
    });
    expect(first.admin).toBe(true);
    expect(userCount()).toBe(1);
    // Email is normalized on write, password verifies via the same helpers
    // the /api/auth routes use.
    expect(verifyCredentials('ops@example.com', 'correct horse battery')).toBeTruthy();

    const second = applyDeclarativeConfig({
      admin: { email: 'attacker@example.com', password: 'totally different' },
    });
    expect(second.admin).toBe(false);
    expect(second.warnings.some(w => w.startsWith('admin:'))).toBe(true);
    expect(userCount()).toBe(1);
    // The original account is untouched — the second entry changed nothing.
    expect(verifyCredentials('ops@example.com', 'correct horse battery')).toBeTruthy();
    expect(verifyCredentials('attacker@example.com', 'totally different')).toBeNull();
    warn.mockRestore();
  });

  it('rejects malformed admin entries at schema validation', () => {
    expect(() => applyDeclarativeConfig({
      admin: { email: 'not-an-email', password: 'long-enough-password' },
    })).toThrow(/invalid declarative config/);
    expect(() => applyDeclarativeConfig({
      admin: { email: 'a@b.co', password: 'short' },
    })).toThrow(/invalid declarative config/);
    expect(userCount()).toBe(0);
  });
});

describe('declarative config license', () => {
  function mockLicenseService(over: Record<string, unknown> = {}) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/license/activate')) {
        return new Response(JSON.stringify({
          valid: true, plan: 'premium', status: 'active', expiresAt: null, ...over,
        }));
      }
      if (url.endsWith('/v1/license/check')) {
        return new Response(JSON.stringify({ plan: 'premium', status: 'active', expiresAt: null }));
      }
      // /v1/latest catalog fetch from the kicked sync — fail it on purpose;
      // syncCatalog catches, logs, and records the error without throwing.
      return new Response('no catalog in tests', { status: 500 });
    });
  }

  beforeEach(() => {
    getDb().prepare("DELETE FROM settings WHERE key IN ('premium_license_key', 'premium_license_status')").run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('validates and stores a configured license key, then kicks a live sync', async () => {
    const fetchMock = mockLicenseService();
    const result = applyDeclarativeConfig({ license: 'flk_valid_test_key' });
    expect(result.license).toBe(true);
    await vi.waitFor(() => expect(getSetting(SETTING_LICENSE_KEY)).toBe('flk_valid_test_key'));
    const called = fetchMock.mock.calls.map(c => String(c[0] instanceof Request ? c[0].url : c[0]));
    expect(called.some(u => u.endsWith('/v1/license/activate'))).toBe(true);
  });

  it('does not store a rejected license key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockLicenseService({ valid: false, reason: 'unknown_key' });
    await activateConfiguredLicense('flk_rejected_key');
    expect(getSetting(SETTING_LICENSE_KEY)).toBeUndefined();
    expect(warn.mock.calls.some(c => String(c[0]).includes('rejected'))).toBe(true);
  });

  it('leaves settings untouched when the license service is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await activateConfiguredLicense('flk_offline_key');
    expect(getSetting(SETTING_LICENSE_KEY)).toBeUndefined();
    expect(warn.mock.calls.some(c => String(c[0]).includes('could not reach'))).toBe(true);
  });

  it('skips activation entirely when the stored key already matches', async () => {
    setSetting(SETTING_LICENSE_KEY, 'flk_already_stored');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await activateConfiguredLicense('flk_already_stored');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-activates when the configured key differs from the stored one (rotation)', async () => {
    setSetting(SETTING_LICENSE_KEY, 'flk_old_key_1');
    mockLicenseService();
    await activateConfiguredLicense('flk_new_key_2');
    expect(getSetting(SETTING_LICENSE_KEY)).toBe('flk_new_key_2');
  });
});
