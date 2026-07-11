import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { applyDeclarativeConfig, applyDeclarativeConfigFromEnv } from '../../services/declarative-config.js';
import { getRoutingStrategy } from '../../services/router.js';

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
});
