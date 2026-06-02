import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// Verifies the V17 intelligence-tier audit (2026-06): size_label is normalized
// to Artificial Analysis Intelligence Index v4.0 bands, and the same model
// family lands in ONE tier regardless of provider.
describe('intelligence tier audit (migrateModelsV17)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function tier(platform: string, modelId: string): string | undefined {
    const row = getDb()
      .prepare('SELECT size_label FROM models WHERE platform = ? AND model_id = ?')
      .get(platform, modelId) as { size_label: string } | undefined;
    return row?.size_label;
  }

  function tiersForFamily(like: string): string[] {
    const rows = getDb()
      .prepare("SELECT DISTINCT size_label FROM models WHERE LOWER(model_id) LIKE ?")
      .all(like.toLowerCase()) as { size_label: string }[];
    return rows.map(r => r.size_label);
  }

  it('promotes frontier-class Gemini Flash models (AA 46–55) to Frontier', () => {
    expect(tier('google', 'gemini-3.5-flash')).toBe('Frontier');
    expect(tier('google', 'gemini-3-flash-preview')).toBe('Frontier');
  });

  it('demotes over-tiered models down from Frontier', () => {
    // Qwen3-Coder 480B (AA 25, non-reasoning coder) → Medium
    expect(tier('nvidia', 'qwen/qwen3-coder-480b-a35b-instruct')).toBe('Medium');
    expect(tier('openrouter', 'qwen/qwen3-coder:free')).toBe('Medium');
    // Mistral Large 3 (AA 23) → Medium
    expect(tier('ollama', 'mistral-large-3:675b')).toBe('Medium');
    // Gemini 2.5 Pro (AA 35) → Large
    expect(tier('google', 'gemini-2.5-pro')).toBe('Large');
    // Nemotron 3 Super 120B (AA 36) → Large
    expect(tier('nvidia', 'nvidia/nemotron-3-super-120b-a12b')).toBe('Large');
  });

  it('demotes lapped models down from Large', () => {
    expect(tier('google', 'gemini-2.5-flash')).toBe('Medium');   // AA 21
    expect(tier('github', 'gpt-4o')).toBe('Medium');             // AA 17
    expect(tier('cohere', 'command-a-03-2025')).toBe('Medium');  // AA 13
    expect(tier('ollama', 'devstral-2:123b')).toBe('Medium');    // AA 22
  });

  it('promotes under-tiered Gemma 4 and Gemini Flash-Lite up to Large', () => {
    expect(tier('nvidia', 'google/gemma-4-31b-it')).toBe('Large');             // AA 39
    expect(tier('google', 'gemini-3.1-flash-lite-preview')).toBe('Large');     // AA 34
  });

  it('demotes weak models to Small', () => {
    expect(tier('sambanova', 'gemma-3-12b-it')).toBe('Small');     // AA 9
    expect(tier('mistral', 'codestral-latest')).toBe('Small');     // AA 8
    expect(tier('cohere', 'command-r-08-2024')).toBe('Small');     // legacy
  });

  it('keeps the qwen3-coder vs qwen3-coder-next split correct', () => {
    expect(tier('ollama', 'qwen3-coder:480b')).toBe('Medium');
    expect(tier('ollama', 'qwen3-coder-next')).toBe('Large');
  });

  it('assigns a single consistent tier per model family across providers', () => {
    // The bug the audit also fixes: same model, different tier per provider.
    expect(tiersForFamily('%llama-4-scout%')).toEqual(['Medium']);
    expect(tiersForFamily('%llama-3.3-70b%')).toEqual(['Medium']);
    expect(tiersForFamily('%gpt-oss-120b%')).toEqual(['Large']);
  });

  it('leaves models with no published AA Index at their seeded tier', () => {
    expect(tier('ollama', 'cogito-2.1:671b')).toBe('Frontier');
    expect(tier('openrouter', 'nousresearch/hermes-3-llama-3.1-405b:free')).toBe('Large');
    expect(tier('openrouter', 'poolside/laguna-m.1:free')).toBe('Large');
  });

  it('keeps genuine frontier models at Frontier', () => {
    expect(tier('google', 'gemini-3.1-pro-preview')).toBe('Frontier');
    expect(tier('cloudflare', '@cf/moonshotai/kimi-k2.6')).toBe('Frontier');
    expect(tier('nvidia', 'z-ai/glm-5.1')).toBe('Frontier');
  });
});
