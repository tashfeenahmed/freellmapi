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
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  // Any other claude-ish alias (incl. Claude Code's opusplan) → the catch-all.
  if (m.startsWith('claude') || m === 'opusplan' || m === 'opusplan-4') return 'default';
  return null;
}

export interface ResolvedAnthropicModel {
  // The catalog model db id to pin, or undefined to auto-route.
  preferredModelDbId?: number;
  // True when we resolved to a specific model (for analytics/pinned labels).
  pinned: boolean;
}

// Resolve the model a `/v1/messages` request should route to, honoring the
// operator's family map. Returns undefined preferredModelDbId to mean
// "auto-route" (the default for every family unless the operator pinned one).
export function resolveAnthropicModel(model?: string): ResolvedAnthropicModel {
  const db = getDb();
  const lookupEnabled = (modelId: string): number | undefined => {
    const row = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(modelId) as { id: number } | undefined;
    return row?.id;
  };

  const family = classifyClaudeFamily(model);
  if (family) {
    const target = getClaudeModelMap()[family];
    if (!target || target === 'auto') return { pinned: false };
    const id = lookupEnabled(target);
    // A pinned-but-now-disabled/removed target degrades gracefully to auto.
    return id != null ? { preferredModelDbId: id, pinned: true } : { pinned: false };
  }

  // Not a Claude alias: treat as a concrete catalog model id and pin it if it
  // exists and is enabled; otherwise auto-route (lenient, like the OpenAI route).
  const id = lookupEnabled((model ?? '').trim());
  return id != null ? { preferredModelDbId: id, pinned: true } : { pinned: false };
}
