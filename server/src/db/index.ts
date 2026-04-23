import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initEncryptionKey } from '../lib/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../data/freeapi.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DB_PATH;
  const isMemory = resolvedPath === ':memory:';

  if (!isMemory) {
    const dataDir = path.dirname(resolvedPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  db = new Database(resolvedPath);
  if (!isMemory) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables(db);
  initEncryptionKey(db);
  seedModels(db);
  migrateModels(db);
  migrateModelsV2(db);
  migrateModelsV3Ranks(db);
  migrateModelsV4(db);
  ensureUnifiedKey(db);

  console.log(`Database initialized at ${resolvedPath}`);
  return db;
}

function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
  `);
}

function seedModels(db: Database.Database) {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM models').get() as { cnt: number };
  if (count.cnt > 0) return;

  const insert = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // NOTE: Limits current as of April 2026. See migrateModels() for in-place updates.
  const models = [
    // Google — gemini-2.5-flash free quotas were cut Dec 2025 (now ~20 RPD, budget much lower than before)
    ['google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 1, 8, 'Frontier', 5, 100, 250000, null, '~12M', 1048576],
    ['google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 4, 5, 'Large', 10, 20, 250000, null, '~3M', 1048576],
    ['google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 8, 3, 'Medium', 15, 1000, 250000, null, '~120M', 1048576],
    // OpenRouter — upgraded DeepSeek R1 -> V3.1 (stronger reasoning); default RPD ~200
    ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    // Cerebras — same 30 RPM / 1M TPD free pool; adding frontier coder, Llama 4 Maverick, GPT-OSS
    ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'qwen3-235b', 'Qwen3 235B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 8192],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
    // GitHub Models — GPT-4o replaced with GPT-5 (same free tier key)
    ['github', 'openai/gpt-5', 'GPT-5 (GitHub)', 1, 7, 'Frontier', 10, 50, null, null, '~18M', 128000],
    // SambaNova — 70B RPM bumped to 20
    ['sambanova', 'Meta-Llama-3.3-70B-Instruct', 'Llama 3.3 70B', 6, 9, 'Large', 20, null, null, 200000, '~6M', 8192],
    // Mistral — Experiment pool ~1B tokens/mo shared across all models
    ['mistral', 'mistral-large-latest', 'Mistral Large 3', 7, 8, 'Large', 2, null, 500000, null, '~50-100M', 131072],
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
    ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
    // Groq — scout TPM corrected to 6k (not 30k)
    ['groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 9, 2, 'Medium', 30, 1000, 6000, 500000, '~15M', 131072],
    ['groq', 'llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 10, 2, 'Medium', 30, 1000, 6000, 1000000, '~30M', 131072],
    // NVIDIA NIM — moved to credit-based model in 2025; no longer truly recurring monthly. Disabled by default.
    ['nvidia', 'meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (NV)', 11, 6, 'Large', 40, null, null, null, 'credits-based', 131072],
    // Cohere — trial tier is 1000 calls/mo total → realistic budget 1-2M
    ['cohere', 'command-r-plus-08-2024', 'Command R+ (08-2024)', 12, 11, 'Large', 20, 33, null, null, '~1-2M', 131072],
    ['cloudflare', '@cf/meta/llama-3.1-70b-instruct', 'Llama 3.1 70B (CF)', 13, 11, 'Medium', null, null, null, null, '~18-45M', 131072],
    // Hugging Face — free Inference credits are ~$0.10/mo → budget closer to 1-3M on a 70B model
    ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (HF)', 14, 11, 'Medium', null, null, null, null, '~1-3M', 131072],
    // New providers — recurring monthly free tiers, no card required
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
    ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
  ];

  const insertMany = db.transaction(() => {
    for (const m of models) {
      insert.run(...m);
    }
  });
  insertMany();

  // Seed default fallback config from models
  const allModels = db.prepare('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC').all() as { id: number; intelligence_rank: number }[];
  const insertFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
  const insertFallbacks = db.transaction(() => {
    for (let i = 0; i < allModels.length; i++) {
      insertFallback.run(allModels[i].id, i + 1);
    }
  });
  insertFallbacks();

  console.log(`Seeded ${models.length} models and fallback config`);
}

/**
 * Idempotent migration to bring existing DBs up to the April 2026 pool.
 * Covers: replaces outdated models (DeepSeek R1 → V3.1, GPT-4o → GPT-5),
 * corrects stale rate-limits / monthly budgets, adds new smarter models
 * and three new providers (Zhipu, Moonshot, MiniMax).
 */
function migrateModels(db: Database.Database) {
  // 1) Replace outdated models in-place (preserves fallback_config & any references)
  const renames: Array<[string, string, string, string, number, string, number | null, number | null, number]> = [
    // platform, oldModelId, newModelId, newDisplayName, intelligenceRank, monthlyBudget, rpdLimit, contextWindow, sizeLabelPriority(unused)
  ];
  const renameStmt = db.prepare(`
    UPDATE models
       SET model_id = ?, display_name = ?, intelligence_rank = ?,
           monthly_token_budget = ?, rpd_limit = COALESCE(?, rpd_limit),
           context_window = COALESCE(?, context_window),
           size_label = COALESCE(?, size_label)
     WHERE platform = ? AND model_id = ?
  `);
  // DeepSeek R1 (free) -> DeepSeek V3.1 (free)
  renameStmt.run('deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, '~6M', 200, 131072, 'Frontier', 'openrouter', 'deepseek/deepseek-r1:free');
  // GitHub GPT-4o -> GPT-5
  renameStmt.run('openai/gpt-5', 'GPT-5 (GitHub)', 1, '~18M', null, 128000, 'Frontier', 'github', 'gpt-4o');

  // 2) Correct stale limits / budgets on existing rows
  db.prepare(`UPDATE models SET rpd_limit = 20, monthly_token_budget = '~3M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'`).run();
  db.prepare(`UPDATE models SET rpm_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'`).run();
  db.prepare(`UPDATE models SET tpm_limit = 6000 WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'`).run();
  db.prepare(`UPDATE models SET monthly_token_budget = '~1-2M' WHERE platform = 'cohere' AND model_id = 'command-r-plus-08-2024'`).run();
  db.prepare(`UPDATE models SET monthly_token_budget = '~1-3M' WHERE platform = 'huggingface' AND model_id = 'accounts/fireworks/models/llama-v3p3-70b-instruct'`).run();
  // NVIDIA moved to credit model — disable and label accordingly
  db.prepare(`UPDATE models SET monthly_token_budget = 'credits-based', enabled = 0 WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'`).run();

  // 3) Insert new models (UNIQUE(platform, model_id) makes this idempotent)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const newModels: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // Cerebras — same free pool as qwen3-235b
    ['cerebras', 'qwen-3-coder-480b', 'Qwen3-Coder 480B', 2, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 3, 1, 'Frontier', 30, null, 60000, 1000000, '~30M', 131072],
    ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3, 1, 'Large', 30, null, 60000, 1000000, '~30M', 131072],
    // OpenRouter free tier
    ['openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'moonshotai/kimi-k2:free', 'Kimi K2 (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 3, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'z-ai/glm-4.5-air:free', 'GLM-4.5 Air (free)', 4, 9, 'Large', 20, 200, null, null, '~6M', 131072],
    // Mistral Experiment pool — shared ~1B/mo across models
    ['mistral', 'magistral-medium-latest', 'Magistral Medium', 4, 8, 'Large', 2, null, 500000, null, '~50-100M', 40000],
    ['mistral', 'codestral-latest', 'Codestral', 6, 6, 'Medium', 2, null, 500000, null, '~50-100M', 32000],
    // New providers
    ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 5, 4, 'Large', null, null, null, 1000000, '~30M', 131072],
    ['moonshot', 'kimi-latest', 'Kimi Latest', 4, 8, 'Large', 60, null, null, 500000, '~15M', 200000],
    ['minimax', 'MiniMax-M1', 'MiniMax M1', 5, 8, 'Large', 20, null, 1000000, null, '~30M', 200000],
  ];

  const apply = db.transaction(() => {
    for (const m of newModels) insert.run(...m);

    // Ensure every model has a fallback_config row (new inserts + any orphans)
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL
      ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFallback = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) {
        addFallback.run(missing[i].id, maxPriority + i + 1);
      }
    }
  });
  apply();
}

/**
 * Second-pass migration after live-testing every model against its provider.
 * Corrects model IDs verified wrong, removes models not actually available on
 * the current free tier, and adds real :free OpenRouter models found in the
 * live catalog (April 2026).
 */
function migrateModelsV2(db: Database.Database) {
  // Helper: delete a model and its fallback_config entry (FK is RESTRICT-by-default)
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    // GitHub free tier does NOT include GPT-5 (only catalog-listed). Revert handled below.
    // Cerebras: qwen-3-coder-480b and llama-4-maverick not on free tier; gpt-oss-120b is listed
    // but requires special access — our key gets 404. Remove all three.
    ['cerebras', 'qwen-3-coder-480b'],
    ['cerebras', 'llama-4-maverick-17b-128e-instruct'],
    ['cerebras', 'gpt-oss-120b'],
    // These OpenRouter :free variants do not exist in the live catalog (April 2026)
    ['openrouter', 'deepseek/deepseek-v3.1:free'],
    ['openrouter', 'moonshotai/kimi-k2:free'],
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  // GitHub: gpt-5 is in the model catalog but returns "unavailable_model" on free tier
  // inference. Revert to gpt-4o which works. This only runs if the gpt-5 row exists.
  db.prepare(`
    UPDATE models
       SET model_id = 'gpt-4o', display_name = 'GPT-4o', intelligence_rank = 5,
           size_label = 'Large', context_window = 8000, monthly_token_budget = '~18M'
     WHERE platform = 'github' AND model_id = 'openai/gpt-5'
  `).run();

  // Groq: scout requires the meta-llama/ publisher prefix
  db.prepare(`
    UPDATE models SET model_id = 'meta-llama/llama-4-scout-17b-16e-instruct'
     WHERE platform = 'groq' AND model_id = 'llama-4-scout-17b-16e-instruct'
  `).run();

  // Add real OpenRouter :free models that exist in the live catalog
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // Frontier-tier free models verified in OR catalog 2026-04
    ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (free)', 2, 9, 'Frontier', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free', 'Qwen3-Next 80B (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 262144],
    ['openrouter', 'minimax/minimax-m2.5:free', 'MiniMax M2.5 (free)', 3, 9, 'Large', 20, 200, null, null, '~6M', 196608],
    ['openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B (free)', 5, 9, 'Medium', 20, 200, null, null, '~6M', 262144],
  ];
  const applyAdditions = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    // Fallback entries for new models
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  applyAdditions();
}

/**
 * Re-rank intelligence based on April 2026 coding + agentic tool-use benchmarks:
 * SWE-bench Verified, Terminal-Bench 2, TAU-Bench, Aider Polyglot.
 * Higher rank = weaker. Ties are allowed (same weights across providers).
 */
function migrateModelsV3Ranks(db: Database.Database) {
  const setRank = db.prepare(`UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?`);
  const ranks: Array<[number, string, string]> = [
    // #1-10 frontier coders / agents
    [1,  'openrouter',  'minimax/minimax-m2.5:free'],                     // SWE-V ~80%, TB2 ~57%
    [2,  'openrouter',  'qwen/qwen3-coder:free'],                         // SWE-V ~70%
    [3,  'openrouter',  'qwen/qwen3-next-80b-a3b-instruct:free'],         // SWE-V ~70.6%
    [4,  'moonshot',    'kimi-latest'],                                   // K2: SWE-V ~71%
    [5,  'cerebras',    'qwen-3-235b-a22b-instruct-2507'],                // SWE-V ~65-72%
    [6,  'google',      'gemini-2.5-pro'],                                // SWE-V 63.8%, Aider 83%
    [7,  'openrouter',  'z-ai/glm-4.5-air:free'],                         // ~58% SWE-V (distill of 4.5)
    [8,  'openrouter',  'openai/gpt-oss-120b:free'],                      // SWE-V 62.4%
    [9,  'openrouter',  'nvidia/nemotron-3-super-120b-a12b:free'],        // SWE-V 53.7%
    [10, 'minimax',     'MiniMax-M1'],                                    // M1 predecessor, ~45-55%
    // #11-15 mid-tier specialists
    [11, 'mistral',     'codestral-latest'],                              // HumanEval 86.6%
    [12, 'mistral',     'mistral-large-latest'],
    [13, 'mistral',     'magistral-medium-latest'],                       // reasoning, not code-tuned
    [14, 'google',      'gemini-2.5-flash'],
    [15, 'zhipu',       'glm-4.5-flash'],
    // #16 Llama 3.3 70B — identical weights across providers (tie)
    [16, 'groq',        'llama-3.3-70b-versatile'],
    [16, 'sambanova',   'Meta-Llama-3.3-70B-Instruct'],
    [16, 'openrouter',  'meta-llama/llama-3.3-70b-instruct:free'],
    [16, 'huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    // #17-23 weaker
    [17, 'openrouter',  'nousresearch/hermes-3-llama-3.1-405b:free'],     // L3.1 base with tool-use tune
    [18, 'groq',        'meta-llama/llama-4-scout-17b-16e-instruct'],     // multimodal focus
    [19, 'openrouter',  'google/gemma-4-31b-it:free'],
    [20, 'google',      'gemini-2.5-flash-lite'],
    [21, 'github',      'gpt-4o'],                                        // Aug 2024, SWE-V ~33%
    [22, 'nvidia',      'meta/llama-3.1-70b-instruct'],                   // older Llama 3.1 tune
    [22, 'cloudflare',  '@cf/meta/llama-3.1-70b-instruct'],               // same base weights
    [23, 'cohere',      'command-r-plus-08-2024'],                        // RAG-focused, weakest on code
  ];
  const apply = db.transaction(() => {
    for (const [rank, platform, modelId] of ranks) {
      setRank.run(rank, platform, modelId);
    }
  });
  apply();
}

/**
 * V4: Agentic-tool-use focus. Live-probed every candidate against real free-tier
 * keys (April 2026) with a weather-tool function-calling test. Keeps only models
 * that return a structured tool_calls response and are reachable on the free tier.
 *
 * Adds SambaNova DeepSeek/Llama-4/gpt-oss, Groq gpt-oss & qwen3-32b, OpenRouter
 * ling-2.6-flash + nemotron-nano + gpt-oss + trinity, Mistral devstral/medium,
 * GitHub gpt-4.1, Cohere command-a, Cloudflare llama-4/gpt-oss/glm-4.7. Removes
 * moonshot/kimi (paid-only now), minimax/M1 (superseded), HF/Fireworks route
 * (no structured tools), OR/gemma-4 (weak at tools). Renames CF llama-3.1 → 3.3
 * fp8-fast. Corrects stale limits.
 */
function migrateModelsV4(db: Database.Database) {
  // 1) Remove entries that are unavailable or fail agentic tool use
  const deleteModel = db.prepare(`DELETE FROM models WHERE platform = ? AND model_id = ?`);
  const deleteFallback = db.prepare(`
    DELETE FROM fallback_config WHERE model_db_id IN (
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    )
  `);
  const removals: Array<[string, string]> = [
    ['moonshot', 'kimi-latest'],                                            // paid-only now ($1 min deposit)
    ['minimax', 'MiniMax-M1'],                                              // superseded; use OR minimax-m2.5:free
    ['openrouter', 'google/gemma-4-31b-it:free'],                           // weak at tool use
    ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],  // emits tool call as text content, not structured
  ];
  const applyRemovals = db.transaction(() => {
    for (const [p, m] of removals) {
      deleteFallback.run(p, m);
      deleteModel.run(p, m);
    }
  });
  applyRemovals();

  // 2) Cloudflare: replace Llama 3.1 70B with the current-gen 3.3 70B fp8-fast
  db.prepare(`
    UPDATE models
       SET model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
           display_name = 'Llama 3.3 70B fp8-fast (CF)',
           context_window = 131072
     WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.1-70b-instruct'
  `).run();

  // 3) Field corrections verified via primary sources + live probe
  db.prepare(`UPDATE models SET tpm_limit = 12000 WHERE platform = 'groq' AND model_id = 'llama-3.3-70b-versatile'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 20 WHERE platform = 'sambanova' AND model_id = 'Meta-Llama-3.3-70B-Instruct'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 14400 WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'`).run();
  db.prepare(`UPDATE models SET rpd_limit = 250, monthly_token_budget = '~25M' WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'`).run();
  // gemini-2.5-pro is at-risk: April 2026 Google moved Pro-class off free tier in practice.
  // Our live probe hit "quota exceeded" immediately. Cut rpd in half to reduce 429 blast radius.
  db.prepare(`UPDATE models SET rpd_limit = 50, monthly_token_budget = '~6M' WHERE platform = 'google' AND model_id = 'gemini-2.5-pro'`).run();

  // 4) Add live-probed, tool-capable models
  const insert = db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const additions: Array<[string, string, string, number, number, string, number | null, number | null, number | null, number | null, string, number | null]> = [
    // OpenRouter :free — shared 20 RPM / 200 RPD / ~6M tokens across :free pool
    ['openrouter', 'inclusionai/ling-2.6-flash:free',        'Ling 2.6 Flash (free)',         7,  9,  'Large',    20, 200, null, null, '~6M', 262144],
    ['openrouter', 'arcee-ai/trinity-large-preview:free',    'Trinity Large Preview (free)',  13, 9,  'Frontier', 20, 200, null, null, '~6M', 131072],
    ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free',    'Nemotron 3 Nano 30B (free)',    22, 9,  'Medium',   20, 200, null, null, '~6M', 262144],
    ['openrouter', 'openai/gpt-oss-120b:free',               'GPT-OSS 120B (free)',           6,  9,  'Large',    20, 200, null, null, '~6M', 131072],
    ['openrouter', 'openai/gpt-oss-20b:free',                'GPT-OSS 20B (free)',            18, 9,  'Medium',   20, 200, null, null, '~6M', 131072],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)',          17, 9,  'Medium',   20, 200, null, null, '~6M', 131072],

    // SambaNova — 20 RPM / 20 RPD / 200K TPD shared free Developer tier
    ['sambanova',  'DeepSeek-V3.1',                          'DeepSeek V3.1',                 5,  9,  'Frontier', 20, 20,  null, 200000, '~3M', 131072],
    ['sambanova',  'DeepSeek-V3.2',                          'DeepSeek V3.2',                 4,  9,  'Frontier', 20, 20,  null, 200000, '~3M', 131072],
    ['sambanova',  'Llama-4-Maverick-17B-128E-Instruct',     'Llama 4 Maverick',              11, 9,  'Large',    20, 20,  null, 200000, '~3M', 8192],
    ['sambanova',  'gpt-oss-120b',                           'GPT-OSS 120B (SambaNova)',      6,  9,  'Large',    20, 20,  null, 200000, '~3M', 131072],

    // Groq — very fast; 30 RPM per model, 1000 RPD on most, 14.4k on the 8B
    ['groq',       'openai/gpt-oss-120b',                    'GPT-OSS 120B (Groq)',           6,  2,  'Large',    30, 1000, 8000, 200000,  '~6M',  131072],
    ['groq',       'openai/gpt-oss-20b',                     'GPT-OSS 20B (Groq)',            18, 2,  'Medium',   30, 1000, 8000, 200000,  '~6M',  131072],
    ['groq',       'qwen/qwen3-32b',                         'Qwen3 32B (Groq)',              19, 2,  'Medium',   60, 1000, 6000, 500000,  '~15M', 131072],
    ['groq',       'llama-3.1-8b-instant',                   'Llama 3.1 8B Instant',          28, 2,  'Small',    30, 14400, 6000, 500000, '~15M', 131072],

    // Mistral Experiment tier — shared 2 RPM / 500k TPM / 1B tokens/mo across all models
    ['mistral',    'devstral-latest',                        'Devstral',                      16, 8,  'Medium',   2, null, 500000, null, '~50-100M', 131072],
    ['mistral',    'mistral-medium-latest',                  'Mistral Medium 3.5',            14, 8,  'Large',    2, null, 500000, null, '~50-100M', 131072],

    // GitHub Models — Low-tier category (15 RPM / 150 RPD, 8K in / 4K out per call)
    ['github',     'openai/gpt-4.1',                         'GPT-4.1 (GitHub)',              20, 7,  'Large',    10, 50,  null, null, '~9M', 128000],

    // Cohere — shared 1000 calls/mo trial pool, 20 RPM Chat
    ['cohere',     'command-a-03-2025',                      'Command-A (03-2025)',           27, 11, 'Large',    20, 33,  null, null, '~1-2M', 131072],

    // Cloudflare Workers AI — shared 10K Neurons/day free pool across all @cf/* models
    ['cloudflare', '@cf/openai/gpt-oss-120b',                'GPT-OSS 120B (CF)',             6,  11, 'Large',    null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/zai-org/glm-4.7-flash',              'GLM-4.7 Flash (CF)',            10, 11, 'Large',    null, null, null, null, '~18-45M', 131072],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout (CF)',            12, 11, 'Large',    null, null, null, null, '~18-45M', 131072],
  ];

  const apply = db.transaction(() => {
    for (const a of additions) insert.run(...a);
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      for (let i = 0; i < missing.length; i++) addFb.run(missing[i].id, maxPriority + i + 1);
    }
  });
  apply();

  // 5) Re-rank the live catalog by agentic tool-use capability (lower = smarter).
  //    Grounded in April 2026 SWE-Bench Verified + BFCL v3 + Tau-Bench numbers.
  const setRank = db.prepare(`UPDATE models SET intelligence_rank = ? WHERE platform = ? AND model_id = ?`);
  const ranks: Array<[number, string, string]> = [
    [1,  'openrouter',  'minimax/minimax-m2.5:free'],
    [2,  'openrouter',  'qwen/qwen3-coder:free'],
    [3,  'openrouter',  'qwen/qwen3-next-80b-a3b-instruct:free'],
    [4,  'sambanova',   'DeepSeek-V3.2'],
    [5,  'sambanova',   'DeepSeek-V3.1'],
    [6,  'cerebras',    'qwen-3-235b-a22b-instruct-2507'],
    [6,  'openrouter',  'openai/gpt-oss-120b:free'],
    [6,  'groq',        'openai/gpt-oss-120b'],
    [6,  'sambanova',   'gpt-oss-120b'],
    [6,  'cloudflare',  '@cf/openai/gpt-oss-120b'],
    [7,  'openrouter',  'inclusionai/ling-2.6-flash:free'],
    [8,  'openrouter',  'z-ai/glm-4.5-air:free'],
    [10, 'cloudflare',  '@cf/zai-org/glm-4.7-flash'],
    [11, 'sambanova',   'Llama-4-Maverick-17B-128E-Instruct'],
    [12, 'groq',        'meta-llama/llama-4-scout-17b-16e-instruct'],
    [12, 'cloudflare',  '@cf/meta/llama-4-scout-17b-16e-instruct'],
    [13, 'openrouter',  'arcee-ai/trinity-large-preview:free'],
    [14, 'google',      'gemini-2.5-pro'],
    [14, 'mistral',     'mistral-large-latest'],
    [14, 'mistral',     'mistral-medium-latest'],
    [16, 'mistral',     'devstral-latest'],
    [16, 'mistral',     'codestral-latest'],
    [17, 'groq',        'llama-3.3-70b-versatile'],
    [17, 'sambanova',   'Meta-Llama-3.3-70B-Instruct'],
    [17, 'cloudflare',  '@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    [17, 'openrouter',  'meta-llama/llama-3.3-70b-instruct:free'],
    [17, 'nvidia',      'meta/llama-3.1-70b-instruct'],
    [18, 'openrouter',  'openai/gpt-oss-20b:free'],
    [18, 'groq',        'openai/gpt-oss-20b'],
    [19, 'groq',        'qwen/qwen3-32b'],
    [20, 'google',      'gemini-2.5-flash'],
    [20, 'github',      'openai/gpt-4.1'],
    [21, 'mistral',     'magistral-medium-latest'],
    [22, 'openrouter',  'nvidia/nemotron-3-super-120b-a12b:free'],
    [23, 'openrouter',  'nvidia/nemotron-3-nano-30b-a3b:free'],
    [24, 'zhipu',       'glm-4.5-flash'],
    [25, 'github',      'gpt-4o'],
    [26, 'google',      'gemini-2.5-flash-lite'],
    [27, 'cohere',      'command-a-03-2025'],
    [27, 'cohere',      'command-r-plus-08-2024'],
    [28, 'groq',        'llama-3.1-8b-instant'],
  ];
  const applyRanks = db.transaction(() => {
    for (const [r, p, m] of ranks) setRank.run(r, p, m);
  });
  applyRanks();
}

function ensureUnifiedKey(db: Database.Database) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string } | undefined;
  if (!existing) {
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
    console.log(`\n  Your unified API key: ${key}\n`);
  }
}

export function getUnifiedApiKey(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string };
  return row.value;
}

export function regenerateUnifiedKey(): string {
  const db = getDb();
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'").run(key);
  return key;
}
