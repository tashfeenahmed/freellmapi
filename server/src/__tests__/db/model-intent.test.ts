import { beforeAll, describe, expect, it } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

describe('model intent metadata', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('tags seeded models for coding, research, and chat routing', () => {
    const db = getDb();

    const coder = db.prepare(`
      SELECT coding_bias, research_bias, chat_bias
      FROM models
      WHERE platform = 'openrouter' AND model_id = 'qwen/qwen3-coder:free'
    `).get() as { coding_bias: number; research_bias: number; chat_bias: number } | undefined;
    const research = db.prepare(`
      SELECT coding_bias, research_bias, chat_bias
      FROM models
      WHERE platform = 'cohere' AND model_id = 'command-a-reasoning-08-2025'
    `).get() as { coding_bias: number; research_bias: number; chat_bias: number } | undefined;
    const chat = db.prepare(`
      SELECT coding_bias, research_bias, chat_bias
      FROM models
      WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'
    `).get() as { coding_bias: number; research_bias: number; chat_bias: number } | undefined;

    expect(coder).toMatchObject({ coding_bias: 1, research_bias: 0, chat_bias: 0 });
    expect(research).toMatchObject({ coding_bias: 0, research_bias: 1, chat_bias: 0 });
    expect(chat).toMatchObject({ coding_bias: 0, research_bias: 0, chat_bias: 1 });
  });
});
