import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  // Check if providers exist
  const countRes = await client.query('SELECT COUNT(*) as count FROM providers');
  const count = parseInt(countRes.rows[0]?.count || '0', 10);
  if (count > 0) return;

  const defaultProviders = [
    { key: 'google', name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com', priority: 10 },
    { key: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1', priority: 9 },
    { key: 'cerebras', name: 'Cerebras', url: 'https://api.cerebras.ai/v1', priority: 9 },
    { key: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', priority: 8 },
    { key: 'mistral', name: 'Mistral AI', url: 'https://api.mistral.ai/v1', priority: 7 },
    { key: 'github', name: 'GitHub Models', url: 'https://models.github.ai/inference', priority: 7 },
    { key: 'cohere', name: 'Cohere', url: 'https://api.cohere.com/v2', priority: 6 },
    { key: 'cloudflare', name: 'Cloudflare Workers AI', url: 'https://api.cloudflare.com/client/v4', priority: 5 },
    { key: 'zhipu', name: 'Zhipu AI (GLM)', url: 'https://open.bigmodel.cn/api/paas/v4', priority: 6 },
    { key: 'ollama', name: 'Ollama Cloud', url: 'https://ollama.com/v1', priority: 5 },
    { key: 'kilo', name: 'Kilo Gateway', url: 'https://api.kilo.ai/api/gateway/v1', priority: 4 },
    { key: 'pollinations', name: 'Pollinations', url: 'https://gen.pollinations.ai/v1', priority: 4 },
    { key: 'llm7', name: 'LLM7', url: 'https://api.llm7.io/v1', priority: 3 },
    { key: 'opencode', name: 'OpenCode Zen', url: 'https://opencode.ai/zen/v1', priority: 3 },
    { key: 'ovh', name: 'OVHcloud AI', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', priority: 3 },
    { key: 'custom', name: 'Custom OpenAI Endpoint', url: null, priority: 1 },
  ];

  const providerMap = new Map<string, number>();

  for (const p of defaultProviders) {
    const res = await client.query(
      `INSERT INTO providers (provider_key, display_name, base_url, enabled, priority)
       VALUES ($1, $2, $3, true, $4)
       RETURNING id`,
      [p.key, p.name, p.url, p.priority]
    );
    providerMap.set(p.key, res.rows[0].id);
  }

  // Seed default models
  const defaultModels = [
    // Google
    { provider: 'google', modelId: 'gemini-2.5-pro', canonical: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', ctx: 1048576, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: true, priority: 10 },
    { provider: 'google', modelId: 'gemini-2.5-flash', canonical: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', ctx: 1048576, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: true, priority: 9 },
    { provider: 'google', modelId: 'gemini-2.5-flash-lite', canonical: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', ctx: 1048576, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: false, priority: 8 },
    // Groq
    { provider: 'groq', modelId: 'llama-3.3-70b-versatile', canonical: 'llama-3.3-70b', name: 'Llama 3.3 70B (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 9 },
    { provider: 'groq', modelId: 'llama-4-scout-17b-16e-instruct', canonical: 'llama-4-scout', name: 'Llama 4 Scout (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 8 },
    // Cerebras
    { provider: 'cerebras', modelId: 'qwen-3-coder-480b', canonical: 'qwen-3-coder', name: 'Qwen3-Coder 480B (Cerebras)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: true, priority: 9 },
    { provider: 'cerebras', modelId: 'llama-4-maverick-17b-128e-instruct', canonical: 'llama-4-maverick', name: 'Llama 4 Maverick (Cerebras)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 8 },
    // OpenRouter
    { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.1:free', canonical: 'deepseek-v3.1', name: 'DeepSeek V3.1 (free)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: true, priority: 9 },
    { provider: 'openrouter', modelId: 'moonshotai/kimi-k2:free', canonical: 'kimi-k2', name: 'Kimi K2 (free)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 8 },
    { provider: 'openrouter', modelId: 'qwen/qwen3-coder:free', canonical: 'qwen3-coder', name: 'Qwen3 Coder (free)', ctx: 262144, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: true, priority: 8 },
    // Mistral
    { provider: 'mistral', modelId: 'mistral-large-latest', canonical: 'mistral-large', name: 'Mistral Large 3', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: false, priority: 8 },
    { provider: 'mistral', modelId: 'codestral-latest', canonical: 'codestral', name: 'Codestral', ctx: 32000, maxOut: 4096, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 7 },
    // GitHub
    { provider: 'github', modelId: 'openai/gpt-5', canonical: 'gpt-5', name: 'GPT-5 (GitHub)', ctx: 128000, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: true, priority: 10 },
    // Zhipu
    { provider: 'zhipu', modelId: 'glm-4.5-flash', canonical: 'glm-4.5-flash', name: 'GLM-4.5 Flash', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 7 },
  ];

  for (const m of defaultModels) {
    const providerId = providerMap.get(m.provider);
    if (!providerId) continue;
    await client.query(
      `INSERT INTO models (
         provider_id, model_id, canonical_name, display_name, enabled,
         context_window, max_output_tokens, supports_streaming, supports_tools,
         supports_vision, supports_structured_output, supports_reasoning, priority
       )
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [
        providerId, m.modelId, m.canonical, m.name,
        m.ctx, m.maxOut, m.stream, m.tools, m.vision, m.structOut, m.reasoning, m.priority
      ]
    );
  }

  // Seed default routing settings
  await client.query(
    `INSERT INTO routing_configuration (config_key, config_value)
     VALUES
       ('strategy', '{"name": "bandit", "explorationRate": 0.1}'::jsonb),
       ('weights', '{"speed": 0.35, "intelligence": 0.35, "reliability": 0.30}'::jsonb),
       ('limits', '{"maxRetries": 2, "baseBackoffMs": 250, "maxBackoffMs": 5000}'::jsonb)
     ON CONFLICT (config_key) DO NOTHING`
  );
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query('DELETE FROM models; DELETE FROM providers; DELETE FROM routing_configuration;');
}
