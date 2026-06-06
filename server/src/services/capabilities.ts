import type Database from 'better-sqlite3';
import { execSync } from 'child_process';

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Sync model capabilities from OpenRouter's public API into the models table.
 *
 * This is the AUTHORITATIVE source for model metadata. When a model is found
 * on OpenRouter, ALL its capability fields are overwritten from the API:
 *   - context_window  (from context_length)
 *   - supports_vision (from input_modalities containing "image")
 *   - supports_reasoning (from supports_reasoning flag)
 *   - rpm_limit / rpd_limit (from limit_rpm / limit_rpd)
 *
 * V16 (vision) and V22 (tools) LIKE rules still run BEFORE this function
 * as a fallback baseline — but only models NOT found on OpenRouter keep
 * those hardcoded values.
 *
 * The sync runs synchronously at startup (one ~2s HTTP call to a free,
 * unauthenticated endpoint). Failures are logged but never fatal — the
 * migration fallbacks ensure models still work if the API is unreachable.
 */
export interface SyncResult {
  updated: number;
  unmatched: { platform: string; modelId: string; displayName: string }[];
  total: number;
  matched: number;
  /** Number of models enriched from platform-specific specs (post-OpenRouter sync). */
  platformSynced: number;
  error?: string;
}

export function syncCapabilities(db: Database.Database): void {
  const result = syncCapabilitiesDetailed(db);
  if (result.error) console.error('[Caps] OpenRouter sync failed, using migration fallbacks:', result.error);
  else {
    const parts = [`${result.matched}/${result.total} matched`];
    if (result.updated > 0) parts.unshift(`updated ${result.updated} models`);
    if (result.platformSynced > 0) parts.push(`${result.platformSynced} from platform specs`);
    console.log(`[Caps] OpenRouter sync: ${parts.join(', ')}`);
  }
}

/** Detailed sync that returns unmatched models for UI display. */
export function syncCapabilitiesDetailed(db: Database.Database): SyncResult {
  try {
    const result = syncFromOpenRouterFrontend(db);
    // After OpenRouter sync, enrich remaining unmatched models from platform specs.
    const platformSynced = syncPlatformSpecs(db, result.unmatched);
    return { ...result, platformSynced };
  } catch (err) {
    return { updated: 0, unmatched: [], total: 0, matched: 0, platformSynced: 0, error: (err as Error).message };
  }
}

// ── OpenRouter /api/frontend/models sync ──────────────────────────────────

interface OpenRouterFrontendModel {
  slug: string;
  context_length: number;
  input_modalities: string[];
  output_modalities: string[];
  supports_reasoning: boolean;
  reasoning_config: { effort?: string; return_reasoning?: boolean } | null;
  limit_rpm: number;
  limit_rpd: number;
  hidden: boolean;
}

interface OpenRouterFrontendResponse {
  data: OpenRouterFrontendModel[];
}

/** Internal return from the OpenRouter sync — before platform specs enrichment. */
interface OpenRouterSyncResult {
  updated: number;
  unmatched: { platform: string; modelId: string; displayName: string }[];
  total: number;
  matched: number;
}

/**
 * Fetch OpenRouter's public frontend model list and apply capability data
 * to matching entries in our models table. Returns the number of rows updated.
 *
 * This endpoint (/api/frontend/models) is free, requires no auth, and returns
 * rich metadata for 766+ models:
 * - context_length: accurate context window per model
 * - supports_reasoning: whether the model supports chain-of-thought
 * - input_modalities: vision (image), audio, video support
 * - limit_rpm / limit_rpd: provider rate limits
 */
function syncFromOpenRouterFrontend(db: Database.Database): OpenRouterSyncResult {
  // Use a blocking fetch with timeout — this runs at boot and we need the
  // data before the server starts accepting requests.
  const res = fetchSync('https://openrouter.ai/api/frontend/models', 30000);

  const body = res as OpenRouterFrontendResponse;
  if (!Array.isArray(body.data)) {
    throw new Error('OpenRouter /api/frontend/models returned unexpected shape');
  }

  // Build three lookups:
  // 1. modelsBySlug: normalized slug → model metadata (exact match)
  // 2. modelsByName: full model name (part after /) → best version
  // 3. modelsByBaseName: name with trailing version stripped → best version
  //    E.g. 'codestral-2508' → base 'codestral' → maps to the highest version
  const modelsBySlug = new Map<string, OpenRouterFrontendModel>();
  const modelsByName = new Map<string, OpenRouterFrontendModel>();
  const modelsByBaseName = new Map<string, OpenRouterFrontendModel>();
  for (const m of body.data) {
    if (!m.slug) continue;
    modelsBySlug.set(m.slug.toLowerCase(), m);
    const nameMatch = m.slug.match(/\/([^/]+)$/);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const existing = modelsByName.get(name);
    if (!existing || extractVersion(m.slug) > extractVersion(existing.slug)) {
      modelsByName.set(name, m);
    }
    // Base name: strip trailing version number (e.g. 'devstral-2512' → 'devstral')
    const baseName = name.replace(/-\d+$/, '');
    if (baseName !== name) {
      const existingBase = modelsByBaseName.get(baseName);
      if (!existingBase || extractVersion(m.slug) > extractVersion(existingBase.slug)) {
        modelsByBaseName.set(baseName, m);
      }
    }
  }

  // Walk every enabled model, match against the OR catalog, and OVERWRITE
  // all fields. The API is authoritative — if a model is found on OpenRouter,
  // its API values replace any hardcoded migration values.
  const update = db.prepare(`
    UPDATE models SET supports_vision = ?, supports_tools = ?, supports_reasoning = ?,
                      context_window = ?, rpm_limit = ?, rpd_limit = ?
     WHERE id = ?
  `);

  let updated = 0;
  const unmatched: { platform: string; modelId: string; displayName: string }[] = [];
  let matched = 0;
  let total = 0;
  const apply = db.transaction(() => {
    const rows = db.prepare(
      'SELECT id, platform, model_id, display_name, supports_tools FROM models WHERE enabled = 1'
    ).all() as {
      id: number; platform: string; model_id: string; display_name: string;
      supports_tools: number;
    }[];

    total = rows.length;

    for (const row of rows) {
      const meta = findModel(row.platform, row.model_id, modelsBySlug, modelsByName, modelsByBaseName);
      if (!meta) {
        unmatched.push({ platform: row.platform, modelId: row.model_id, displayName: row.display_name });
        continue;
      }
      matched++;

      const newVision = meta.input_modalities.includes('image') ? 1 : 0;
      const newReasoning = meta.supports_reasoning ? 1 : 0;
      const newCtx = meta.context_length > 0 ? meta.context_length : null;
      const current = db.prepare(
        'SELECT rpm_limit, rpd_limit, supports_vision, supports_reasoning, context_window FROM models WHERE id = ?'
      ).get(row.id) as { rpm_limit: number | null; rpd_limit: number | null; supports_vision: number; supports_reasoning: number; context_window: number | null };
      const newRpm = meta.limit_rpm > 0 ? meta.limit_rpm : current.rpm_limit;
      const newRpd = meta.limit_rpd > 0 ? meta.limit_rpd : current.rpd_limit;

      if (
        current.supports_vision === newVision &&
        current.supports_reasoning === newReasoning &&
        current.context_window === newCtx
      ) continue;

      update.run(newVision, row.supports_tools, newReasoning, newCtx, newRpm, newRpd, row.id);
      updated++;
    }
  });
  apply();
  return { updated, unmatched, total, matched };
}

/**
 * Synchronous fetch wrapper for boot-time use. Uses Node's built-in fetch
 * but wraps it in a blocking pattern via child_process.execSync + curl as
 * a fallback if the runtime doesn't support sync fetch.
 */
function fetchSync(url: string, timeoutMs: number): unknown {
  // Blocking fetch via curl — runs at boot before the server accepts requests.
  const stdout = execSync(
    `curl -s --max-time ${Math.floor(timeoutMs / 1000)} "${url}"`,
    { encoding: 'utf8', timeout: timeoutMs + 5000, maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

/**
 * Match a (platform, model_id) pair against the OpenRouter frontend catalog.
 * Suffixes like `:free`, `-free`, and `-latest` are stripped before matching.
 * Version-aware: when multiple OR slugs share a name, the highest version wins.
 */
export function findModel(
  platform: string,
  modelId: string,
  modelsBySlug: Map<string, OpenRouterFrontendModel>,
  modelsByName: Map<string, OpenRouterFrontendModel>,
  modelsByBaseName: Map<string, OpenRouterFrontendModel>,
): OpenRouterFrontendModel | null {
  // Normalize: strip :free / -free / -latest suffixes.
  // E.g. 'google/gemini-2.5-flash:free' → 'google/gemini-2.5-flash'
  //       'minimax-m3-free' → 'minimax-m3'
  //       'devstral-latest' → 'devstral'
  const normalized = modelId.replace(/[:-]free$/i, '').replace(/-latest$/i, '').toLowerCase();

  // Strategy 1: direct slug lookup with normalized ID
  const direct = modelsBySlug.get(normalized);
  if (direct) return direct;

  // Strategy 2: direct slug lookup with original ID (no suffix stripping)
  if (normalized !== modelId.toLowerCase()) {
    const orig = modelsBySlug.get(modelId.toLowerCase());
    if (orig) return orig;
  }

  // Strategy 3: base-name lookup (highest version wins)
  // E.g. 'devstral' → matches 'mistralai/devstral-2512' (highest version)
  const ourName = extractName(normalized);
  if (ourName) {
    const byBase = modelsByBaseName.get(ourName);
    if (byBase) return byBase;
  }

  // Strategy 4: exact name lookup (e.g. 'deepseek-v4-flash' matches slug name directly)
  if (ourName) {
    const byName = modelsByName.get(ourName);
    if (byName) return byName;
  }

  // Strategy 5 (reverse): our normalized model_id contains an OR slug.
  for (const [slug, meta] of modelsBySlug) {
    if (slug.length < 8) continue;
    if (normalized.includes(slug)) return meta;
  }

  // Strategy 6 (loose): any OR slug contains our normalized model_id.
  for (const [slug, meta] of modelsBySlug) {
    if (slug.includes(normalized)) return meta;
  }

  // Strategy 7: name substring — OR slug's name contains our name.
  // E.g. our 'deepseek-v4-flash' matches OR's 'deepseek/deepseek-v4-flash'
  if (ourName && ourName.length >= 8) {
    for (const [name, meta] of modelsByName) {
      if (name.length >= 6 && name.includes(ourName)) return meta;
    }
  }

  // Strategy 8: reverse name substring — our name contains an OR slug's name.
  // E.g. our 'meta-llama-3.3-70b-instruct' contains OR's 'llama-3.3-70b-instruct'
  //      our 'llama-4-maverick-17b-128e-instruct' contains OR's 'llama-4-maverick'
  //      our 'zai-glm-4.7' contains OR's 'glm-4.7'
  // Prefer the LONGEST matching OR name (most specific match).
  if (ourName && ourName.length >= 8) {
    let best: OpenRouterFrontendModel | null = null;
    let bestLen = 0;
    for (const [name, meta] of modelsByName) {
      if (name.length >= 6 && name.length < ourName.length && ourName.includes(name) && name.length > bestLen) {
        best = meta;
        bestLen = name.length;
      }
    }
    if (best) return best;
  }

  return null;
}

// ── Platform-specific model specs ───────────────────────────────────────

/**
 * Static specs for models exclusive to specific platforms (not on OpenRouter).
 * Sourced from provider documentation:
 *   - Groq:   https://console.groq.com/docs/models
 *   - Cerebras: https://inference-docs.cerebras.ai/models/overview
 *   - SambaNova: https://docs.sambanova.ai/docs/en/models/sambacloud-models
 *   - Ollama Cloud: https://ollama.com/library (context from provider cards)
 *   - Pollinations: https://pollinations.ai
 *   - Cloudflare: https://developers.cloudflare.com/workers-ai/models/
 *   - OpenCode: https://opencode.ai/zen/v1/models
 *
 * Key format: 'platform|model_id'. Values override migration fallbacks for
 * models that the OpenRouter sync couldn't match. Only fields that differ
 * from migration defaults need to be specified.
 */
const PLATFORM_MODEL_SPECS: Record<string, { context_window?: number; supports_vision?: boolean; supports_reasoning?: boolean; supports_tools?: boolean }> = {
  // ── Groq ────────────────────────────────────────────────────────────
  // Source: https://console.groq.com/docs/models
  'groq|llama-3.3-70b-versatile':   { context_window: 131072, supports_tools: true },
  'groq|llama-3.1-8b-instant':      { context_window: 131072, supports_tools: true },
  'groq|groq/compound':             { context_window: 131072, supports_tools: true },
  'groq|groq/compound-mini':        { context_window: 131072, supports_tools: true },

  // ── Ollama Cloud ────────────────────────────────────────────────────
  // Source: Ollama Cloud model cards + provider documentation
  'ollama|cogito-2.1:671b':         { context_window: 131072, supports_tools: true },
  'ollama|gpt-oss:120b':            { context_window: 131072, supports_tools: true },
  'ollama|devstral-2:123b':         { context_window: 262144, supports_tools: true },
  'ollama|gpt-oss:20b':             { context_window: 131072, supports_tools: true },
  'ollama|gemma4:31b':              { context_window: 262144 },

  // ── Pollinations ────────────────────────────────────────────────────
  // Source: https://pollinations.ai — single anonymous model (GPT-OSS 20B)
  'pollinations|openai-fast':       { context_window: 131072 },

  // ── Cloudflare Workers AI ───────────────────────────────────────────
  // Source: https://developers.cloudflare.com/workers-ai/models/
  'cloudflare|@cf/nvidia/nemotron-3-120b-a12b': { context_window: 262144, supports_tools: true },

  // ── OpenCode Zen ────────────────────────────────────────────────────
  // Source: https://opencode.ai/zen/v1/models — stealth/promo models
  'opencode|big-pickle':            { context_window: 131072 },
};

/**
 * Apply platform-specific specs to models that weren't matched by OpenRouter.
 * Only touches models whose (platform, model_id) has an entry in
 * PLATFORM_MODEL_SPECS and whose current values differ from the spec.
 * Returns the number of rows updated.
 */
function syncPlatformSpecs(db: Database.Database, unmatched: { platform: string; modelId: string; displayName: string }[]): number {
  if (unmatched.length === 0) return 0;

  let synced = 0;
  const update = db.prepare(`
    UPDATE models SET context_window = ?, supports_vision = ?, supports_reasoning = ?, supports_tools = ?
     WHERE id = ?
  `);

  const apply = db.transaction(() => {
    for (const u of unmatched) {
      const key = `${u.platform}|${u.modelId}`;
      const spec = PLATFORM_MODEL_SPECS[key];
      if (!spec) continue;

      const row = db.prepare(
        'SELECT id, context_window, supports_vision, supports_reasoning, supports_tools FROM models WHERE platform = ? AND model_id = ?'
      ).get(u.platform, u.modelId) as {
        id: number; context_window: number | null;
        supports_vision: number; supports_reasoning: number; supports_tools: number;
      } | undefined;
      if (!row) continue;

      const newCtx = spec.context_window ?? row.context_window;
      const newVision = spec.supports_vision !== undefined ? (spec.supports_vision ? 1 : 0) : row.supports_vision;
      const newReasoning = spec.supports_reasoning !== undefined ? (spec.supports_reasoning ? 1 : 0) : row.supports_reasoning;
      const newTools = spec.supports_tools !== undefined ? (spec.supports_tools ? 1 : 0) : row.supports_tools;

      if (
        row.context_window === newCtx &&
        row.supports_vision === newVision &&
        row.supports_reasoning === newReasoning &&
        row.supports_tools === newTools
      ) continue;

      update.run(newCtx, newVision, newReasoning, newTools, row.id);
      synced++;
    }
  });
  apply();
  return synced;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Extract the trailing version number from a slug (e.g. 'mistralai/devstral-2512' → 2512). */
function extractVersion(slug: string): number {
  const match = slug.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

/** Extract the model name from a normalized ID or slug (part after the last `/`). */
function extractName(normalized: string): string | null {
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
