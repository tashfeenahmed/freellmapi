import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';

// Claude Code model mapping. Claude Code keeps its built-in model names
// (e.g. `claude-sonnet-4-5` as the main model, `claude-3-5-haiku` as the
// small/fast background model) and sends them verbatim to `/v1/messages`.
// Since this proxy serves a free model pool (not the real Claude cloud
// models), we map each Claude family to either "auto" (let the router pick —
// the default and the common case) or a specific catalog model the operator
// pins. A concrete catalog model id sent directly (e.g. the user set
// ANTHROPIC_MODEL to one of our models) bypasses the map and pins as-is.
//
// Stored as a JSON blob in the `settings` table — no migration needed.

const SETTING_KEY = 'anthropic_model_map';

export const CLAUDE_FAMILIES = ['default', 'opus', 'sonnet', 'haiku'] as const;
export type ClaudeFamily = (typeof CLAUDE_FAMILIES)[number];
// Each value is either the sentinel 'auto' or a catalog model_id.
export type AnthropicModelMap = Record<ClaudeFamily, string>;

const DEFAULT_MAP: AnthropicModelMap = { default: 'auto', opus: 'auto', sonnet: 'auto', haiku: 'auto' };

export const anthropicModelMapSchema = z.object({
  default: z.string().min(1).optional(),
  opus: z.string().min(1).optional(),
  sonnet: z.string().min(1).optional(),
  haiku: z.string().min(1).optional(),
}).strict();

export function getClaudeModelMap(): AnthropicModelMap {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return { ...DEFAULT_MAP };
  try {
    const p = JSON.parse(raw) as Partial<AnthropicModelMap>;
    return {
      default: typeof p.default === 'string' && p.default ? p.default : 'auto',
      opus: typeof p.opus === 'string' && p.opus ? p.opus : 'auto',
      sonnet: typeof p.sonnet === 'string' && p.sonnet ? p.sonnet : 'auto',
      haiku: typeof p.haiku === 'string' && p.haiku ? p.haiku : 'auto',
    };
  } catch {
    return { ...DEFAULT_MAP };
  }
}

export function setClaudeModelMap(input: unknown): AnthropicModelMap {
  const patch = anthropicModelMapSchema.parse(input);
  const current = getClaudeModelMap();
  const next: AnthropicModelMap = {
    default: patch.default ?? current.default,
    opus: patch.opus ?? current.opus,
    sonnet: patch.sonnet ?? current.sonnet,
    haiku: patch.haiku ?? current.haiku,
  };
  setSetting(SETTING_KEY, JSON.stringify(next));
  return next;
}

// Classify a requested model into a Claude family, or null when it's not a
// Claude alias at all (a concrete catalog id meant to pin directly).
export function classifyClaudeFamily(model?: string): ClaudeFamily | null {
  const m = (model ?? '').trim().toLowerCase();
  if (!m || m === 'auto' || m === 'default' || m === 'freellmapi-auto') return 'default';
  // Claude Code's planning alias is opus-ish by name but must hit the catch-all,
  // so match it before the substring family checks below.
  if (m === 'opusplan' || m === 'opusplan-4') return 'default';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  // Any other claude-ish alias → the catch-all.
  if (m.startsWith('claude')) return 'default';
  return null;
}

export interface ResolvedAnthropicModel {
  // The catalog model db id to pin, or undefined to auto-route.
  preferredModelDbId?: number;
  // The catalog model_id that db id belongs to, when one was pinned. Callers
  // widen this into the model's cross-provider group so a failure fails over to
  // the SAME model on another provider (the strict chain /v1/chat/completions
  // and /v1/responses already build) instead of to an unrelated model.
  modelId?: string;
  // True when we resolved to a specific model (for analytics/pinned labels).
  pinned: boolean;
}

// Resolve the model a `/v1/messages` request should route to, honoring the
// operator's family map. Returns undefined preferredModelDbId to mean
// "auto-route" (the default for every family unless the operator pinned one).
export function resolveAnthropicModel(model?: string): ResolvedAnthropicModel {
  const db = getDb();
  // A model_id can exist on several platforms at once (the same open-weights
  // model relayed by two providers). The row we pin is only the head hint —
  // the caller routes over the whole group — but an arbitrary SQLite row order
  // made the head flap between providers run to run, so pick deterministically:
  // chain priority first (ascending, as everywhere else), then insertion order.
  const lookupEnabled = (modelId: string): { id: number; model_id: string } | undefined =>
    db.prepare(`
      SELECT m.id as id, m.model_id as model_id
      FROM models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.model_id = ? AND m.enabled = 1
      ORDER BY COALESCE(fc.priority, 0) ASC, m.id ASC
      LIMIT 1
    `).get(modelId) as { id: number; model_id: string } | undefined;

  const family = classifyClaudeFamily(model);
  if (family) {
    const target = getClaudeModelMap()[family];
    if (!target || target === 'auto') return { pinned: false };
    const row = lookupEnabled(target);
    // A pinned-but-now-disabled/removed target degrades gracefully to auto.
    return row ? { preferredModelDbId: row.id, modelId: row.model_id, pinned: true } : { pinned: false };
  }

  // Not a Claude alias: treat as a concrete catalog model id and pin it if it
  // exists and is enabled; otherwise auto-route (lenient, like the OpenAI route).
  const row = lookupEnabled((model ?? '').trim());
  return row ? { preferredModelDbId: row.id, modelId: row.model_id, pinned: true } : { pinned: false };
}

// The canonical Claude id this gateway answers to for each family, and the
// label discovery shows for it.
//
// These are NOT real Claude cloud models and are not presented as such: every
// one of them is already accepted by `/v1/messages`, where classifyClaudeFamily
// maps it onto the free pool through the operator's family map. They are listed
// in `GET /v1/models` because some Anthropic clients only accept ids that look
// like Claude models and reject a catalog of free-model ids outright. Claude
// Desktop's third-party gateway picker is the reported case (#880): it fetched
// the full catalog over HTTP 200 and still reported "found 0 models", because
// nothing in it belonged to a Claude family.
//
// Listing them is honest in the sense that matters for discovery: these are ids
// the gateway really will serve. The display name says where the request
// actually goes so nobody reads the entry as hosted Claude.
export const CLAUDE_FAMILY_ALIASES: { id: string; family: ClaudeFamily; label: string }[] = [
  { id: 'claude-opus-4-5', family: 'opus', label: 'Opus' },
  { id: 'claude-sonnet-4-5', family: 'sonnet', label: 'Sonnet' },
  { id: 'claude-haiku-4-5', family: 'haiku', label: 'Haiku' },
];

// Discovery entries for the family aliases, named after where each one routes:
// the pinned catalog model when the operator pinned one, otherwise the router.
export function claudeFamilyDiscoveryEntries(): { id: string; displayName: string }[] {
  const map = getClaudeModelMap();
  return CLAUDE_FAMILY_ALIASES.map(({ id, family, label }) => {
    const target = map[family];
    return {
      id,
      displayName: !target || target === 'auto'
        ? `${label} slot (auto-routed to a free model)`
        : `${label} slot (routed to ${target})`,
    };
  });
}
