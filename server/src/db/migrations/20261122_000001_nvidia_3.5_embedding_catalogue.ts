// Embedding catalogue: add missing nvidia/nemotron-3.5-embed-1b and -8b entries.
// These models are live at NVIDIA's API but absent from the FreeLLMAPI catalogue
// (snapshot v2026.11.16). Adding them restores dashboard selection and server-side
// truncation (3.5 supports MRL truncation to 1536/1024/512; 3 does not).
//
// Live probe results (two independent keys, identical):
//   - dimensions unset    -> HTTP 200, vector length 2048
//   - dimensions 2048     -> HTTP 200, vector length 2048
//   - dimensions 1536     -> HTTP 200, vector length 1536  (3.5 only!)
//   - dimensions 1024     -> HTTP 200, vector length 1024  (3.5 only!)
//   - dimensions 512      -> HTTP 200, vector length 512   (3.5 only!)
//   - 3 does NOT accept dimensions override -> HTTP 400 "must be one of 2048"
//
// Suggested catalogue entries (one per model):
//   family: "nemotron-3.5-embed-1b",  platform: "nvidia", modelId: "nvidia/nemotron-3.5-embed-1b"
//   family: "nemotron-3.5-embed-8b",   platform: "nvidia", modelId: "nvidia/nemotron-3.5-embed-8b"

import type { Db } from '../types.js';

export function up(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO embedding_models
      (family, platform, model_id, display_name, dimensions, max_input_tokens, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Nemotron 3.5 Embed 1B
  insert.run([
    'nemotron-3.5-embed-1b',       // family
    'nvidia',                      // platform
    'nvidia/nemotron-3.5-embed-1b', // model_id
    'Nemotron 3.5 Embed 1B',       // display_name
    2048,                          // dimensions
    4096,                          // max_input_tokens
    1,                             // priority
    1,                             // enabled
    '~40 rpm'                      // quota_label
  ]);

  // Nemotron 3.5 Embed 8B
  insert.run([
    'nemotron-3.5-embed-8b',       // family
    'nvidia',                      // platform
    'nvidia/nemotron-3.5-embed-8b', // model_id
    'Nemotron 3.5 Embed 8B',       // display_name
    2048,                          // dimensions
    4096,                          // max_input_tokens
    1,                             // priority
    1,                             // enabled
    '~40 rpm'                      // quota_label
  ]);
}

export function down(db: Db): void {
  const remove = db.prepare(`
    DELETE FROM embedding_models
    WHERE family IN ('nemotron-3.5-embed-1b', 'nemotron-3.5-embed-8b')
  `);
  remove.run();
}
