import type DatabaseType from 'better-sqlite3';

export interface ModelIntentFlags {
  codingBias: number;
  researchBias: number;
  chatBias: number;
}

function normalize(text: string): string {
  return text.toLowerCase();
}

export function inferModelIntentFlags(row: {
  platform: string;
  model_id: string;
  display_name: string;
  size_label?: string | null;
  supports_tools?: number | null;
  context_window?: number | null;
}): ModelIntentFlags {
  const haystack = normalize(`${row.platform} ${row.model_id} ${row.display_name}`);

  const coding = (row.supports_tools ?? 0) === 1 && (
    haystack.includes('coder') ||
    haystack.includes('codestral') ||
    haystack.includes('devstral') ||
    haystack.includes('gpt-oss') ||
    haystack.includes('deepseek-v3') ||
    haystack.includes('deepseek-v4') ||
    haystack.includes('qwen3') ||
    haystack.includes('qwen-3') ||
    haystack.includes('glm-') ||
    haystack.includes('nemotron') ||
    haystack.includes('minimax-m3') ||
    haystack.includes('opencode') ||
    haystack.includes('mistral-large') ||
    haystack.includes('mistral-medium') ||
    haystack.includes('mistral-small')
  );

  const explicitResearch = (
    haystack.includes('reasoning') ||
    haystack.includes('deepseek-v4') ||
    haystack.includes('command-a') ||
    haystack.includes('kimi-k2') ||
    haystack.includes('nemotron-3-super') ||
    haystack.includes('nemotron-3-ultra') ||
    haystack.includes('glm-4.7') ||
    haystack.includes('glm-4.6') ||
    haystack.includes('gpt-5')
  );
  const research = explicitResearch || (
    row.size_label === 'Frontier' ||
    row.size_label === 'Large' ||
    haystack.includes('pro') ||
    haystack.includes('ultra') ||
    haystack.includes('gemini-3') ||
    haystack.includes('deepseek-v3')
  );

  const chat = (
    haystack.includes('flash') ||
    haystack.includes('flash-lite') ||
    haystack.includes('mini') ||
    haystack.includes('haiku') ||
    haystack.includes('scout') ||
    haystack.includes('chat') ||
    haystack.includes('instruct') ||
    haystack.includes('gpt-4o') ||
    haystack.includes('gpt-oss-20b') ||
    haystack.includes('gemini-2.5-flash') ||
    haystack.includes('llama-3.3-70b') ||
    haystack.includes('mistral-small') ||
    haystack.includes('mistral-medium')
  );

  return {
    codingBias: coding ? 1 : 0,
    researchBias: research ? 1 : 0,
    chatBias: chat ? 1 : 0,
  };
}

export function refreshModelIntentFlags(db: DatabaseType.Database): void {
  const rows = db.prepare(`
    SELECT id, platform, model_id, display_name, size_label, supports_tools, context_window
    FROM models
  `).all() as Array<{
    id: number;
    platform: string;
    model_id: string;
    display_name: string;
    size_label: string;
    supports_tools: number;
    context_window: number | null;
  }>;

  const update = db.prepare(`
    UPDATE models
    SET coding_bias = ?, research_bias = ?, chat_bias = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      const flags = inferModelIntentFlags(row);
      update.run(flags.codingBias, flags.researchBias, flags.chatBias, row.id);
    }
  });
  tx();
}
