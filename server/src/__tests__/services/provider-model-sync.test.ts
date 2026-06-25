import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  DYNAMIC_MODEL_PLATFORMS,
  isLikelyChatModel,
  inferIntelligenceRank,
  syncProviderModels,
  deleteModelsForKey,
  backfillDiscoveredModelsToDefaultProfile,
} from '../../services/provider-model-sync.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';

describe('provider-model-sync', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    vi.restoreAllMocks();
  });

  it('marks alibaba as a dynamic-catalog platform', () => {
    expect(DYNAMIC_MODEL_PLATFORMS.has('alibaba')).toBe(true);
  });

  it('filters non-chat alibaba SKUs', () => {
    expect(isLikelyChatModel('qwen-plus', 'alibaba')).toBe(true);
    expect(isLikelyChatModel('text-embedding-v4', 'alibaba')).toBe(false);
    expect(isLikelyChatModel('qwen-image-plus', 'alibaba')).toBe(false);
    expect(isLikelyChatModel('qwen3-tts-flash', 'alibaba')).toBe(false);
  });

  it('ranks frontier alibaba models ahead of small ones', () => {
    expect(inferIntelligenceRank('qwen3.7-max', 'alibaba')).toBeLessThan(inferIntelligenceRank('qwen3-8b', 'alibaba'));
  });

  it('syncs chat models from /v1/models and probes them', async () => {
    const db = getDb();
    const key = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('alibaba', 'test', 'x', 'y', 'z', 'unknown', 1)
    `).run();
    const keyId = Number(key.lastInsertRowid);

    vi.spyOn(OpenAICompatProvider.prototype, 'listModels').mockResolvedValue([
      'qwen-plus',
      'text-embedding-v4',
      'qwen-image-plus',
    ]);
    vi.spyOn(OpenAICompatProvider.prototype, 'chatCompletion').mockResolvedValue({
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: 'qwen-plus',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const result = await syncProviderModels('alibaba', 'sk-test', keyId, { probe: true });
    expect(result.fetched).toBe(3);
    expect(result.chatCandidates).toBe(1);
    expect(result.enabled).toBe(1);
    expect(result.models[0]?.modelId).toBe('qwen-plus');

    const row = db.prepare("SELECT * FROM models WHERE platform = 'alibaba' AND model_id = 'qwen-plus'").get() as {
      key_id: number; enabled: number;
    };
    expect(row.key_id).toBe(keyId);
    expect(row.enabled).toBe(1);
    const inProfile = db.prepare(`
      SELECT 1 FROM profile_models pm
      JOIN profiles p ON p.id = pm.profile_id AND p.type = 'default'
      WHERE pm.model_db_id = ?
    `).get(row.id);
    expect(inProfile).toBeTruthy();
  });

  it('backfillDiscoveredModelsToDefaultProfile adds missing profile rows', () => {
    const db = getDb();
    const model = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, key_id)
      VALUES ('alibaba', 'qwen-plus', 'Qwen Plus', 4, 4, 'Discovered', 1, 1)
    `).run();
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 99, 1)').run(model.lastInsertRowid);

    expect(backfillDiscoveredModelsToDefaultProfile(db, 'alibaba')).toBe(1);
    expect(db.prepare('SELECT COUNT(1) AS c FROM profile_models WHERE model_db_id = ?').get(model.lastInsertRowid)).toEqual({ c: 1 });
  });

  it('deleteModelsForKey removes bound models and fallback rows', () => {
    const db = getDb();
    const key = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('alibaba', 'test', 'x', 'y', 'z', 'unknown', 1)
    `).run();
    const keyId = Number(key.lastInsertRowid);
    const model = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, key_id)
      VALUES ('alibaba', 'qwen-plus', 'Qwen Plus', 4, 4, 'Discovered', 1, ?)
    `).run(keyId);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(model.lastInsertRowid);

    expect(deleteModelsForKey(db, 'alibaba', keyId)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM models WHERE platform = 'alibaba'").get()).toEqual({ c: 0 });
  });
});
