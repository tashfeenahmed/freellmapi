// Model catalog in the format Codex CLI reads from `model_catalog_url` (or a
// local `model_catalog_json`). Without it Codex logs "Model metadata for <id>
// not found" and falls back to generic settings for gateway-only model ids.
//
// A catalog entry does more than silence that warning: Codex takes the
// entry's `base_instructions` as its whole system prompt and decides which
// tools to offer from the entry's flags. So every entry starts from Codex's
// OWN fallback for unknown models (`model_info_from_slug` in
// codex-rs/models-manager/src/model_info.rs) and changes only what this
// gateway actually knows better: the id and name, the real context window,
// and whether the model takes images. Everything else stays as Codex would
// have used anyway, which matters here because:
//   - `apply_patch_tool_type: 'freeform'` and `supports_search_tool` make Codex
//     send Responses-API `custom` / `web_search` tools, and /v1/responses
//     forwards function tools only (routes/responses.ts `toChatTools`), so the
//     model would be told about tools it never receives;
//   - `support_verbosity` / reasoning-effort updates add request fields free
//     chat-completions upstreams do not honour.
import { CODEX_BASE_INSTRUCTIONS } from './codex-base-instructions.js';

const CODEX_FALLBACK_DEFAULTS = {
  default_reasoning_level: null,
  supported_reasoning_levels: [] as unknown[],
  shell_type: 'unified_exec',
  visibility: 'list',
  supported_in_api: true,
  priority: 99,
  additional_speed_tiers: [] as string[],
  service_tiers: [] as unknown[],
  availability_nux: null,
  upgrade: null,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  supports_reasoning_summary_parameter: true,
  default_reasoning_summary: 'auto',
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: null,
  web_search_tool_type: 'text',
  truncation_policy: { mode: 'bytes', limit: 10_000 },
  supports_image_detail_original: false,
  comp_hash: null,
  effective_context_window_percent: 95,
  experimental_supported_tools: [] as string[],
  supports_search_tool: false,
  supports_experimental_context: false,
  supports_reasoning_effort_updates: false,
  node_repl_auto_review_required: false,
  node_repl_disabled: false,
};

/**
 * Convert OpenAI-shaped catalog entries (the rows behind GET /v1/models) into a
 * Codex catalog. Entries without a known context window are skipped rather than
 * given an invented one. `visionById` says which catalog ids accept images;
 * ids it does not know (auto, fusion, named chains) keep Codex's default of
 * text + image, since the router steers image requests to vision models.
 */
export function buildCodexCatalog(
  entries: Array<Record<string, unknown>>,
  visionById: ReadonlyMap<string, boolean> = new Map(),
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
      ...CODEX_FALLBACK_DEFAULTS,
      context_window: window,
      max_context_window: window,
      input_modalities: visionById.get(id) === false ? ['text'] : ['text', 'image'],
      base_instructions: CODEX_BASE_INSTRUCTIONS,
    });
  }
  return { models };
}
