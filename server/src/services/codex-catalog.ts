// Model catalog in the format Codex CLI reads from `model_catalog_url` (or a
// local `model_catalog_json`). Without it Codex logs "Model metadata for <id>
// not found" and falls back to generic settings for gateway-only model ids.
//
// Shape checked against Codex CLI 0.167.0 (`codex debug models`). Codex rejects
// an entry that omits `base_instructions`, so a short generic one is sent.
const CODEX_BASE_INSTRUCTIONS = 'You are a helpful coding assistant.';

const CODEX_ENTRY_DEFAULTS = {
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [{ effort: 'medium', description: 'Default' }],
  shell_type: 'unified_exec',
  visibility: 'list',
  supported_in_api: true,
  priority: 2,
  additional_speed_tiers: [] as string[],
  service_tiers: [] as unknown[],
  availability_nux: null,
  upgrade: null,
  model_messages: null,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  default_reasoning_summary: 'none',
  support_verbosity: true,
  default_verbosity: 'low',
  apply_patch_tool_type: 'freeform',
  web_search_tool_type: 'text_and_image',
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_image_detail_original: true,
  comp_hash: '3000',
  effective_context_window_percent: 95,
  experimental_supported_tools: [] as string[],
  input_modalities: ['text', 'image'],
  supports_search_tool: true,
  supports_experimental_context: false,
  supports_reasoning_effort_updates: true,
  node_repl_auto_review_required: true,
  node_repl_disabled: false,
  base_instructions: CODEX_BASE_INSTRUCTIONS,
};

/**
 * Convert OpenAI-shaped catalog entries (the rows behind GET /v1/models) into a
 * Codex catalog. Entries without a known context window are skipped rather than
 * given an invented one.
 */
export function buildCodexCatalog(
  entries: Array<Record<string, unknown>>,
): { models: Array<Record<string, unknown>> } {
  const models: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    const window = typeof entry.context_window === 'number' && entry.context_window > 0
      ? entry.context_window
      : null;
    if (!id || window === null) continue;
    const name = typeof entry.name === 'string' && entry.name ? entry.name : id;
    models.push({
      slug: id,
      display_name: name,
      description: name,
      ...CODEX_ENTRY_DEFAULTS,
      context_window: window,
      max_context_window: window,
    });
  }
  return { models };
}
