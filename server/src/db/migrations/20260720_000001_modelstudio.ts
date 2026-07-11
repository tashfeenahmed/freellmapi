import type { Db } from '../types.js';

/**
 * Alibaba Model Studio (Aliyun MAAS) — OpenAI-compatible endpoint.
 * Endpoint: https://ws-vjedqv3gk6xvrbw1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
 *
 * Free-quota models from models.txt (1M tokens each, expires 2026-08-31).
 * Models marked "No Free Quota" are excluded.
 *
 * Four categories seeded:
 *   1. Chat (LLM) — into `models` + `fallback_config`
 *   2. Image (image-gen + video) — into `media_models` (modality='image')
 *   3. Audio (TTS/ASR) — into `media_models` (modality='audio')
 *   4. Embeddings — into `embedding_models`
 *
 * Translation models (qwen-mt-*) and "Multimodel" realtime models are skipped —
 * they use non-standard audio/video streaming protocols that don't map to the
 * chat or media pipelines. Models whose quota says "No Free Quota" are excluded.
 *
 * Idempotent (INSERT OR IGNORE), safe to re-run.
 */
export function up(db: Db): void {
  // ── Guard: ensure optional columns exist ──────────────────────────────────
  const modelCols = (db.prepare('PRAGMA table_info(models)').all() as { name: string }[]).map(c => c.name);
  if (!modelCols.includes('supports_tools')) {
    db.prepare('ALTER TABLE models ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!modelCols.includes('supports_vision')) {
    db.prepare('ALTER TABLE models ADD COLUMN supports_vision INTEGER NOT NULL DEFAULT 0').run();
  }

  // ── 1. CHAT MODELS ────────────────────────────────────────────────────────
  const chatInsert = db.prepare(`
    INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
       enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  // [platform, model_id, display_name, int_rank, spd_rank, size,
  //  rpm, rpd, tpm, tpd, budget, ctx, vision, tools]
  type CR = [string, string, string, number, number, string,
             null, null, null, null, string, number | null, number, number];

  const chatModels: CR[] = [
    // ── Qwen3 235B flagship ────────────────────────────────────────────────
    ['modelstudio', 'qwen3-235b-a22b',               'Qwen3 235B A22B',               2, 2, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-235b-a22b-instruct-2507', 'Qwen3 235B A22B Instruct 2507', 2, 2, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-235b-a22b-thinking-2507', 'Qwen3 235B A22B Thinking 2507', 2, 2, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 0],
    ['modelstudio', 'qwen3-coder-480b-a35b-instruct','Qwen3 Coder 480B A35B Instruct',2, 2, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-coder-next',              'Qwen3 Coder Next',              2, 2, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── Qwen3.7 Max ────────────────────────────────────────────────────────
    ['modelstudio', 'qwen3.7-max',                   'Qwen3.7 Max',                   3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.7-max-2026-06-08',        'Qwen3.7 Max 2026-06-08',        3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.7-max-2026-05-20',        'Qwen3.7 Max 2026-05-20',        3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.7-max-2026-05-17',        'Qwen3.7 Max 2026-05-17',        3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.7-max-preview',           'Qwen3.7 Max Preview',           3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.7-plus',                  'Qwen3.7 Plus',                  4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.7-plus-2026-05-26',       'Qwen3.7 Plus 2026-05-26',       4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── Qwen3.6 ────────────────────────────────────────────────────────────
    ['modelstudio', 'qwen3.6-max-preview',           'Qwen3.6 Max Preview',           4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.6-27b',                   'Qwen3.6 27B',                   6, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.6-35b-a3b',               'Qwen3.6 35B A3B',               5, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.6-plus',                  'Qwen3.6 Plus',                  4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.6-plus-2026-04-02',       'Qwen3.6 Plus 2026-04-02',       4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.6-flash',                 'Qwen3.6 Flash',                 8, 7, 'Medium',   null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.6-flash-2026-04-16',      'Qwen3.6 Flash 2026-04-16',      8, 7, 'Medium',   null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── Qwen3.5 ────────────────────────────────────────────────────────────
    ['modelstudio', 'qwen3.5-397b-a17b',             'Qwen3.5 397B A17B',             2, 2, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.5-122b-a10b',             'Qwen3.5 122B A10B',             3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.5-plus',                  'Qwen3.5 Plus',                  4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.5-plus-2026-04-20',       'Qwen3.5 Plus 2026-04-20',       4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.5-plus-2026-02-15',       'Qwen3.5 Plus 2026-02-15',       4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.5-27b',                   'Qwen3.5 27B',                   6, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.5-35b-a3b',               'Qwen3.5 35B A3B',               6, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.5-flash',                 'Qwen3.5 Flash',                 8, 7, 'Medium',   null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3.5-flash-2026-02-23',      'Qwen3.5 Flash 2026-02-23',      8, 7, 'Medium',   null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── Qwen3 mid-size ─────────────────────────────────────────────────────
    ['modelstudio', 'qwen3-max',                     'Qwen3 Max',                     4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-max-2025-09-23',          'Qwen3 Max 2025-09-23',          4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-max-2026-01-23',          'Qwen3 Max 2026-01-23',          4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-max-preview',             'Qwen3 Max Preview',             4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-32b',                     'Qwen3 32B',                     6, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-14b',                     'Qwen3 14B',                     9, 7, 'Medium',   null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-8b',                      'Qwen3 8B',                     12, 8, 'Small',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-30b-a3b',                 'Qwen3 30B A3B',                 6, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-30b-a3b-instruct-2507',   'Qwen3 30B A3B Instruct 2507',   6, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-30b-a3b-thinking-2507',   'Qwen3 30B A3B Thinking 2507',   6, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 0],
    ['modelstudio', 'qwen3-next-80b-a3b-thinking',   'Qwen3 Next 80B A3B Thinking',   3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 0],
    ['modelstudio', 'qwen3-next-80b-a3b-instruct',   'Qwen3 Next 80B A3B Instruct',   3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── Qwen3 Coder ────────────────────────────────────────────────────────
    ['modelstudio', 'qwen3-coder-plus',              'Qwen3 Coder Plus',              4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-coder-plus-2025-07-22',   'Qwen3 Coder Plus 2025-07-22',   4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-coder-plus-2025-09-23',   'Qwen3 Coder Plus 2025-09-23',   4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-coder-flash',             'Qwen3 Coder Flash',             8, 7, 'Medium',   null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-coder-flash-2025-07-28',  'Qwen3 Coder Flash 2025-07-28',  8, 7, 'Medium',   null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen3-coder-30b-a3b-instruct',  'Qwen3 Coder 30B A3B Instruct',  6, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── Qwen Plus / Turbo / Flash / Max generations ────────────────────────
    ['modelstudio', 'qwen-plus',                     'Qwen Plus',                     7, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-plus-latest',              'Qwen Plus Latest',              7, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-plus-2025-04-28',          'Qwen Plus 2025-04-28',          7, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-plus-2025-07-14',          'Qwen Plus 2025-07-14',          7, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-plus-2025-07-28',          'Qwen Plus 2025-07-28',          7, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-plus-2025-09-11',          'Qwen Plus 2025-09-11',          7, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-plus-character',           'Qwen Plus Character',           9, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 0],
    ['modelstudio', 'qwen-turbo',                    'Qwen Turbo',                   10, 8, 'Medium',   null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-flash',                    'Qwen Flash',                   12, 9, 'Small',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-flash-2025-07-28',         'Qwen Flash 2025-07-28',        12, 9, 'Small',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'qwen-flash-character',          'Qwen Flash Character',         13,10, 'Small',    null, null, null, null, '1M tokens', 131072, 0, 0],
    ['modelstudio', 'qwen-max',                      'Qwen Max',                      5, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── Qwen reasoning ────────────────────────────────────────────────────
    ['modelstudio', 'qwq-plus',                      'QwQ Plus',                      3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 0],
    ['modelstudio', 'qvq-max',                       'QVQ Max',                       3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 1, 0],

    // ── GLM ────────────────────────────────────────────────────────────────
    ['modelstudio', 'glm-5.1',                       'GLM-5.1',                       4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'glm-5.2',                       'GLM-5.2',                       3, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── Kimi / DeepSeek ───────────────────────────────────────────────────
    ['modelstudio', 'kimi-k2.7-code',                'Kimi K2.7 Code',                3, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'deepseek-v4-flash',             'DeepSeek V4 Flash',             4, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'deepseek-v4-pro',               'DeepSeek V4 Pro',               2, 3, 'Frontier', null, null, null, null, '1M tokens', 131072, 0, 1],
    ['modelstudio', 'deepseek-v3.2',                 'DeepSeek V3.2',                 4, 4, 'Large',    null, null, null, null, '1M tokens', 131072, 0, 1],

    // ── VL (vision-language, also accept text-only chat) ──────────────────
    ['modelstudio', 'qwen-vl-ocr-2025-11-20',        'Qwen VL OCR 2025-11-20',       10, 7, 'Large',   null, null, null, null, '1M tokens', 131072, 1, 0],
    ['modelstudio', 'qwen-vl-plus',                  'Qwen VL Plus',                  7, 6, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 0],
    ['modelstudio', 'qwen-vl-max',                   'Qwen VL Max',                   5, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 0],
    ['modelstudio', 'qwen-vl-ocr',                   'Qwen VL OCR',                  10, 7, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 0],
    ['modelstudio', 'qwen3-vl-235b-a22b-thinking',   'Qwen3 VL 235B Thinking',        2, 2, 'Frontier', null, null, null, null, '1M tokens', 131072, 1, 0],
    ['modelstudio', 'qwen3-vl-235b-a22b-instruct',   'Qwen3 VL 235B Instruct',        2, 2, 'Frontier', null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-32b-thinking',         'Qwen3 VL 32B Thinking',         6, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 0],
    ['modelstudio', 'qwen3-vl-32b-instruct',         'Qwen3 VL 32B Instruct',         6, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-30b-a3b-thinking',     'Qwen3 VL 30B A3B Thinking',     6, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 0],
    ['modelstudio', 'qwen3-vl-30b-a3b-instruct',     'Qwen3 VL 30B A3B Instruct',     6, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-8b-thinking',          'Qwen3 VL 8B Thinking',         12, 8, 'Small',    null, null, null, null, '1M tokens', 131072, 1, 0],
    ['modelstudio', 'qwen3-vl-8b-instruct',          'Qwen3 VL 8B Instruct',         12, 8, 'Small',    null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-plus',                 'Qwen3 VL Plus',                 5, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-plus-2025-09-23',      'Qwen3 VL Plus 2025-09-23',      5, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-plus-2025-12-19',      'Qwen3 VL Plus 2025-12-19',      5, 5, 'Large',    null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-flash',                'Qwen3 VL Flash',                9, 8, 'Medium',   null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-flash-2025-10-15',     'Qwen3 VL Flash 2025-10-15',     9, 8, 'Medium',   null, null, null, null, '1M tokens', 131072, 1, 1],
    ['modelstudio', 'qwen3-vl-flash-2026-01-22',     'Qwen3 VL Flash 2026-01-22',     9, 8, 'Medium',   null, null, null, null, '1M tokens', 131072, 1, 1],
  ];

  // ── 2. IMAGE / VIDEO MODELS ────────────────────────────────────────────────
  // From models.txt "Vision" section — image-gen and video models.
  // Only those with free quota (≥1 remaining); skip "No Free Quota" entries.
  const mediaInsert = db.prepare(`
    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);

  // [platform, model_id, display_name, modality, priority, quota_label]
  type MR = [string, string, string, 'image' | 'audio', number, string];

  const imageModels: MR[] = [
    // Image generation (t2i)
    ['modelstudio', 'wan2.2-t2i-flash',             'Wan2.2 T2I Flash',              'image', 10, '50/grant'],
    ['modelstudio', 'wan2.2-t2i-plus',              'Wan2.2 T2I Plus',               'image', 11, '100/grant'],
    ['modelstudio', 'wan2.5-t2i-preview',           'Wan2.5 T2I Preview',            'image', 12, '50/grant'],
    ['modelstudio', 'wan2.6-t2i',                   'Wan2.6 T2I',                    'image', 13, '50/grant'],
    ['modelstudio', 'wan2.7-image',                 'Wan2.7 Image',                  'image', 14, '50/grant'],
    ['modelstudio', 'wan2.7-image-pro',             'Wan2.7 Image Pro',              'image', 15, '50/grant'],
    ['modelstudio', 'wan2.1-t2i-plus',              'Wan2.1 T2I Plus',               'image', 16, '200/grant'],
    ['modelstudio', 'wan2.1-t2i-turbo',             'Wan2.1 T2I Turbo',              'image', 17, '200/grant'],
    ['modelstudio', 'wan2.6-image',                 'Wan2.6 Image',                  'image', 18, '50/grant'],
    // Image editing
    ['modelstudio', 'qwen-image-edit',              'Qwen Image Edit',               'image', 20, '100/grant'],
    ['modelstudio', 'qwen-image-edit-plus',         'Qwen Image Edit Plus',          'image', 21, '100/grant'],
    ['modelstudio', 'qwen-image-edit-plus-2025-10-30','Qwen Image Edit Plus 2025-10-30','image',22,'100/grant'],
    ['modelstudio', 'qwen-image-edit-plus-2025-12-15','Qwen Image Edit Plus 2025-12-15','image',23,'100/grant'],
    ['modelstudio', 'qwen-image-edit-max',          'Qwen Image Edit Max',           'image', 24, '100/grant'],
    ['modelstudio', 'qwen-image-edit-max-2026-01-16','Qwen Image Edit Max 2026-01-16','image',25,'100/grant'],
    // Qwen image generation
    ['modelstudio', 'qwen-image',                   'Qwen Image',                    'image', 30, '100/grant'],
    ['modelstudio', 'qwen-image-2.0',               'Qwen Image 2.0',                'image', 31, '100/grant'],
    ['modelstudio', 'qwen-image-2.0-2026-03-03',    'Qwen Image 2.0 (2026-03-03)',   'image', 32, '100/grant'],
    ['modelstudio', 'qwen-image-2.0-pro',           'Qwen Image 2.0 Pro',            'image', 33, '100/grant'],
    ['modelstudio', 'qwen-image-2.0-pro-2026-03-03','Qwen Image 2.0 Pro (2026-03-03)','image',34,'100/grant'],
    ['modelstudio', 'qwen-image-2.0-pro-2026-04-22','Qwen Image 2.0 Pro (2026-04-22)','image',35,'100/grant'],
    ['modelstudio', 'qwen-image-2.0-pro-2026-06-22','Qwen Image 2.0 Pro (2026-06-22)','image',36,'100/grant'],
    ['modelstudio', 'qwen-image-plus',              'Qwen Image Plus',               'image', 37, '100/grant'],
    ['modelstudio', 'qwen-image-plus-2026-01-09',   'Qwen Image Plus (2026-01-09)',   'image', 38, '100/grant'],
    ['modelstudio', 'qwen-image-max',               'Qwen Image Max',                'image', 39, '100/grant'],
    ['modelstudio', 'qwen-image-max-2025-12-30',    'Qwen Image Max (2025-12-30)',    'image', 40, '100/grant'],
    // z-image
    ['modelstudio', 'z-image-turbo',                'Z-Image Turbo',                 'image', 50, '100/grant'],
    // Video generation
    ['modelstudio', 'wan2.1-t2v-plus',              'Wan2.1 T2V Plus',               'image', 60, '200/grant'],
    ['modelstudio', 'wan2.1-t2v-turbo',             'Wan2.1 T2V Turbo',              'image', 61, '200/grant'],
    ['modelstudio', 'wan2.2-t2v-plus',              'Wan2.2 T2V Plus',               'image', 62, '50/grant'],
    ['modelstudio', 'wan2.2-kf2v-flash',            'Wan2.2 KF2V Flash',             'image', 63, '50/grant'],
    ['modelstudio', 'wan2.5-t2v-preview',           'Wan2.5 T2V Preview',            'image', 64, '50/grant'],
    ['modelstudio', 'wan2.6-t2v',                   'Wan2.6 T2V',                    'image', 65, '50/grant'],
    ['modelstudio', 'wan2.7-t2v',                   'Wan2.7 T2V',                    'image', 66, '50/grant'],
    ['modelstudio', 'wan2.7-t2v-2026-04-25',        'Wan2.7 T2V (2026-04-25)',       'image', 67, '50/grant'],
    ['modelstudio', 'wan2.7-t2v-2026-06-12',        'Wan2.7 T2V (2026-06-12)',       'image', 68, '50/grant'],
    // Image-to-video
    ['modelstudio', 'wan2.1-i2v-plus',              'Wan2.1 I2V Plus',               'image', 70, '200/grant'],
    ['modelstudio', 'wan2.1-i2v-turbo',             'Wan2.1 I2V Turbo',              'image', 71, '200/grant'],
    ['modelstudio', 'wan2.1-kf2v-plus',             'Wan2.1 KF2V Plus',              'image', 72, '200/grant'],
    ['modelstudio', 'wan2.2-i2v-plus',              'Wan2.2 I2V Plus',               'image', 73, '50/grant'],
    ['modelstudio', 'wan2.2-i2v-flash',             'Wan2.2 I2V Flash',              'image', 74, '50/grant'],
    ['modelstudio', 'wan2.2-animate-move',          'Wan2.2 Animate Move',           'image', 75, '50/grant'],
    ['modelstudio', 'wan2.2-animate-mix',           'Wan2.2 Animate Mix',            'image', 76, '50/grant'],
    ['modelstudio', 'wan2.5-i2v-preview',           'Wan2.5 I2V Preview',            'image', 77, '50/grant'],
    ['modelstudio', 'wan2.5-i2i-preview',           'Wan2.5 I2I Preview',            'image', 78, '50/grant'],
    ['modelstudio', 'wan2.6-i2v',                   'Wan2.6 I2V',                    'image', 79, '50/grant'],
    ['modelstudio', 'wan2.6-i2v-flash',             'Wan2.6 I2V Flash',              'image', 80, '50/grant'],
    ['modelstudio', 'wan2.6-r2v',                   'Wan2.6 R2V',                    'image', 81, '50/grant'],
    ['modelstudio', 'wan2.6-r2v-flash',             'Wan2.6 R2V Flash',              'image', 82, '50/grant'],
    ['modelstudio', 'wan2.7-i2v',                   'Wan2.7 I2V',                    'image', 83, '50/grant'],
    ['modelstudio', 'wan2.7-i2v-2026-04-25',        'Wan2.7 I2V (2026-04-25)',       'image', 84, '50/grant'],
    ['modelstudio', 'wan2.7-r2v',                   'Wan2.7 R2V',                    'image', 85, '50/grant'],
    ['modelstudio', 'wan2.7-r2v-2026-06-12',        'Wan2.7 R2V (2026-06-12)',       'image', 86, '50/grant'],
    ['modelstudio', 'wan2.7-videoedit',             'Wan2.7 VideoEdit',              'image', 87, '50/grant'],
    ['modelstudio', 'wan2.1-vace-plus',             'Wan2.1 VACE Plus',              'image', 88, '50/grant'],
    // HappyHorse video
    ['modelstudio', 'happyhorse-1.0-t2v',           'HappyHorse 1.0 T2V',           'image', 90, '10/grant'],
    ['modelstudio', 'happyhorse-1.0-i2v',           'HappyHorse 1.0 I2V',           'image', 91, '10/grant'],
    ['modelstudio', 'happyhorse-1.0-r2v',           'HappyHorse 1.0 R2V',           'image', 92, '10/grant'],
    ['modelstudio', 'happyhorse-1.0-video-edit',    'HappyHorse 1.0 Video Edit',    'image', 93, '10/grant'],
    ['modelstudio', 'happyhorse-1.1-t2v',           'HappyHorse 1.1 T2V',           'image', 94, '10/grant'],
    ['modelstudio', 'happyhorse-1.1-i2v',           'HappyHorse 1.1 I2V',           'image', 95, '10/grant'],
    ['modelstudio', 'happyhorse-1.1-r2v',           'HappyHorse 1.1 R2V',           'image', 96, '10/grant'],
  ];

  // ── 3. AUDIO MODELS ────────────────────────────────────────────────────────
  // TTS and ASR models from models.txt "Audio" section.
  // Skip: voice-enrollment (No Free Quota), qwen-omni-* (realtime — wrong protocol).
  const audioModels: MR[] = [
    // TTS
    ['modelstudio', 'qwen3-tts-flash',                      'Qwen3 TTS Flash',                      'audio', 10, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-flash-2025-09-18',           'Qwen3 TTS Flash 2025-09-18',           'audio', 11, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-flash-2025-11-27',           'Qwen3 TTS Flash 2025-11-27',           'audio', 12, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-flash-realtime',             'Qwen3 TTS Flash Realtime',             'audio', 13, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-flash-realtime-2025-09-18',  'Qwen3 TTS Flash Realtime 2025-09-18',  'audio', 14, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-flash-realtime-2025-11-27',  'Qwen3 TTS Flash Realtime 2025-11-27',  'audio', 15, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-instruct-flash',             'Qwen3 TTS Instruct Flash',             'audio', 16, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-instruct-flash-2026-01-26',  'Qwen3 TTS Instruct Flash 2026-01-26',  'audio', 17, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-instruct-flash-realtime',    'Qwen3 TTS Instruct Flash Realtime',    'audio', 18, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-instruct-flash-realtime-2026-01-22','Qwen3 TTS Instruct Flash Realtime 2026-01-22','audio',19,'10K chars/grant'],
    ['modelstudio', 'qwen3-tts-vd-2026-01-26',             'Qwen3 TTS VD 2026-01-26',             'audio', 20, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-vd-realtime-2025-12-16',    'Qwen3 TTS VD Realtime 2025-12-16',    'audio', 21, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-vd-realtime-2026-01-15',    'Qwen3 TTS VD Realtime 2026-01-15',    'audio', 22, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-vc-2026-01-22',             'Qwen3 TTS VC 2026-01-22',             'audio', 23, '10K chars/grant'],
    ['modelstudio', 'qwen3-tts-vc-realtime-2026-01-15',    'Qwen3 TTS VC Realtime 2026-01-15',    'audio', 24, '10K chars/grant'],
    ['modelstudio', 'cosyvoice-v3-flash',                   'CosyVoice v3 Flash',                   'audio', 25, '10K chars/grant'],
    ['modelstudio', 'cosyvoice-v3-plus',                    'CosyVoice v3 Plus',                    'audio', 26, '10K chars/grant'],
    ['modelstudio', 'qwen-voice-design',                    'Qwen Voice Design',                    'audio', 27, '10/grant'],
    // ASR (speech recognition)
    ['modelstudio', 'qwen3-asr-flash',                      'Qwen3 ASR Flash',                      'audio', 40, '36K sec/grant'],
    ['modelstudio', 'qwen3-asr-flash-2025-09-08',           'Qwen3 ASR Flash 2025-09-08',           'audio', 41, '36K sec/grant'],
    ['modelstudio', 'qwen3-asr-flash-2026-02-10',           'Qwen3 ASR Flash 2026-02-10',           'audio', 42, '36K sec/grant'],
    ['modelstudio', 'qwen3-asr-flash-realtime',             'Qwen3 ASR Flash Realtime',             'audio', 43, '36K sec/grant'],
    ['modelstudio', 'qwen3-asr-flash-realtime-2025-10-27',  'Qwen3 ASR Flash Realtime 2025-10-27',  'audio', 44, '36K sec/grant'],
    ['modelstudio', 'qwen3-asr-flash-realtime-2026-02-10',  'Qwen3 ASR Flash Realtime 2026-02-10',  'audio', 45, '36K sec/grant'],
    ['modelstudio', 'qwen3-asr-flash-filetrans',            'Qwen3 ASR Flash Filetrans',            'audio', 46, '36K sec/grant'],
    ['modelstudio', 'qwen3-asr-flash-filetrans-2025-11-17', 'Qwen3 ASR Flash Filetrans 2025-11-17', 'audio', 47, '36K sec/grant'],
    ['modelstudio', 'fun-asr',                              'FunASR',                               'audio', 50, '36K sec/grant'],
    ['modelstudio', 'fun-asr-2025-08-25',                   'FunASR 2025-08-25',                    'audio', 51, '36K sec/grant'],
    ['modelstudio', 'fun-asr-2025-11-07',                   'FunASR 2025-11-07',                    'audio', 52, '36K sec/grant'],
    ['modelstudio', 'fun-asr-flash-2026-06-15',             'FunASR Flash 2026-06-15',              'audio', 53, '36K sec/grant'],
    ['modelstudio', 'fun-asr-mtl',                          'FunASR MTL',                           'audio', 54, '36K sec/grant'],
    ['modelstudio', 'fun-asr-mtl-2025-08-25',               'FunASR MTL 2025-08-25',                'audio', 55, '36K sec/grant'],
    ['modelstudio', 'fun-asr-realtime',                     'FunASR Realtime',                      'audio', 56, '36K sec/grant'],
    ['modelstudio', 'fun-asr-realtime-2025-11-07',          'FunASR Realtime 2025-11-07',           'audio', 57, '36K sec/grant'],
    // Captioner / Live translate (audio-in text-out — fits the audio tab)
    ['modelstudio', 'qwen3-omni-30b-a3b-captioner',         'Qwen3 Omni 30B Captioner',             'audio', 60, '1M tokens/grant'],
    ['modelstudio', 'qwen3-livetranslate-flash-realtime',   'Qwen3 LiveTranslate Flash Realtime',   'audio', 61, '1M tokens/grant'],
    ['modelstudio', 'qwen3-livetranslate-flash-realtime-2025-09-22','Qwen3 LiveTranslate Flash Realtime 2025-09-22','audio',62,'1M tokens/grant'],
    ['modelstudio', 'qwen3.5-livetranslate-flash-realtime', 'Qwen3.5 LiveTranslate Flash Realtime', 'audio', 63, '1M tokens/grant'],
    ['modelstudio', 'qwen3.5-livetranslate-flash-realtime-2026-05-19','Qwen3.5 LiveTranslate Flash Realtime 2026-05-19','audio',64,'1M tokens/grant'],
    ['modelstudio', 'qwen-voice-enrollment',                'Qwen Voice Enrollment',                'audio', 65, '1K samples/grant'],
  ];

  // ── 4. EMBEDDING MODELS ────────────────────────────────────────────────────
  const embedInsert = db.prepare(`
    INSERT OR IGNORE INTO embedding_models
      (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  // [family, platform, model_id, display_name, dims, max_input, priority, quota_label]
  type ER = [string, string, string, string, number, number | null, number, string];

  const embedModels: ER[] = [
    ['text-embedding-v4',        'modelstudio', 'text-embedding-v4',        'Text Embedding v4 (Model Studio)',        1536, 8192,  1, '1M tokens/grant'],
    ['text-embedding-v3',        'modelstudio', 'text-embedding-v3',        'Text Embedding v3 (Model Studio)',        1024, 8192,  2, '1M tokens/grant'],
    ['tongyi-embedding-vision-plus', 'modelstudio', 'tongyi-embedding-vision-plus', 'Tongyi Embedding Vision Plus', 1024, null, 3, '1M tokens/grant'],
    ['tongyi-embedding-vision-flash','modelstudio', 'tongyi-embedding-vision-flash','Tongyi Embedding Vision Flash',1024, null, 4, '1M tokens/grant'],
    // qwen3-rerank is a reranking model, skip — it doesn't emit vectors
  ];

  // ── Run all inserts in one transaction ────────────────────────────────────
  const apply = db.transaction(() => {
    for (const m of chatModels) chatInsert.run(...m);
    for (const m of [...imageModels, ...audioModels]) mediaInsert.run(...m);
    for (const m of embedModels) embedInsert.run(...m);

    // Backfill fallback_config for any chat models not yet in the chain
    const missing = db.prepare(`
      SELECT m.id FROM models m
      LEFT JOIN fallback_config f ON m.id = f.model_db_id
      WHERE f.id IS NULL ORDER BY m.intelligence_rank ASC
    `).all() as { id: number }[];
    if (missing.length > 0) {
      const maxPriority = (db.prepare(
        'SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config'
      ).get() as { mx: number }).mx;
      const addFb = db.prepare(
        'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)'
      );
      for (let i = 0; i < missing.length; i++) {
        addFb.run(missing[i].id, maxPriority + i + 1);
      }
    }
  });
  apply();
}

export function down(db: Db): void {
  db.prepare(`
    DELETE FROM fallback_config
     WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'modelstudio')
  `).run();
  db.prepare("DELETE FROM models WHERE platform = 'modelstudio'").run();
  db.prepare("DELETE FROM media_models WHERE platform = 'modelstudio'").run();
  db.prepare("DELETE FROM embedding_models WHERE platform = 'modelstudio'").run();
}
