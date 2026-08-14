import type { ModelListRow } from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';
import { isUnifyEnabled, getModelGroups } from './model-groups.js';

// A stable created_at for the /v1/models entries; clients only use it for
// display ordering, so a constant avoids needless churn.
export const MODEL_CREATED_AT = '2026-01-01T00:00:00Z';

// Shared catalog-listing logic behind both the OpenAI `GET /v1/models` and the
// Anthropic `GET /v1/models` endpoints, so the two wire formats list the exact
// same models (only the envelope differs). Extracted verbatim from the OpenAI
// proxy route to keep a single source of truth.

export interface NormalizedModel {
  id: string;
  name: string;
  ownedBy: string;
  available: number;
  enabled: number;
  contextWindow: number | null;
  intel: number;
  // Platforms that can serve this entry (group members under unify, a single
  // platform otherwise) + tool capability — feeds /v1/models
  // `supported_parameters` so agents can pick knobs per model.
  platforms: string[];
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface ModelListing {
  // Full catalog, sorted usable-first; callers apply their own `available` filter.
  models: NormalizedModel[];
  // Honest ceiling for the virtual "auto" model: the largest context window
  // among models that can serve a request right now (null when nothing is
  // connected). Computed over available models regardless of any caller filter.
  autoContextWindow: number | null;
}

export function buildModelListing(): ModelListing {
  const availableExpr = `
    (CASE WHEN m.enabled = 1 AND EXISTS (
        SELECT 1 FROM api_keys k
        WHERE k.platform = m.platform
          AND k.enabled = 1
          AND (m.key_id IS NULL OR k.id = m.key_id)
      ) THEN 1 ELSE 0 END)`;
  const db = getDb();

  let allListed: NormalizedModel[];

  if (isUnifyEnabled()) {
    // Unify ON: one entry per logical model group. Pull per-row availability +
    // context keyed by db id, then aggregate over each group's members.
    type AvailRow = { id: number; platform: string; intelligence_rank: number; context_window: number | null; enabled: number; available: number; supports_tools: number; supports_vision: number };
    const rows = db.prepare(`
      SELECT m.id, m.platform, m.intelligence_rank, m.context_window, m.supports_tools, m.supports_vision,
             m.enabled AS enabled, ${availableExpr} AS available
      FROM models m
    `).all() as AvailRow[];
    const byId = new Map(rows.map(r => [r.id, r]));
    allListed = getModelGroups().map(g => {
      const infos = g.members.map(m => byId.get(m.model_db_id)).filter(Boolean) as AvailRow[];
      const ctxs = infos.map(i => i.context_window).filter((c): c is number => c != null);
      return {
        id: g.canonicalId,
        name: g.groupLabel,
        ownedBy: 'freellmapi',
        available: infos.some(i => i.available === 1) ? 1 : 0,
        enabled: infos.some(i => i.enabled === 1) ? 1 : 0,
        contextWindow: ctxs.length ? Math.max(...ctxs) : null,
        intel: infos.length ? Math.min(...infos.map(i => i.intelligence_rank)) : Number.MAX_SAFE_INTEGER,
        platforms: [...new Set(infos.map(i => i.platform))],
        supportsTools: infos.some(i => i.supports_tools === 1),
        supportsVision: infos.some(i => i.supports_vision === 1),
      };
    });
  } else {
    // Unify OFF: one entry per model_id (dedup picks the available, smartest
    // representative row).
    const models = db.prepare(`
      SELECT platform, model_id, display_name, context_window, enabled, available, intelligence_rank, id, supports_tools, supports_vision
      FROM (
        SELECT m.platform, m.model_id, m.display_name, m.context_window, m.intelligence_rank, m.id, m.supports_tools, m.supports_vision,
               m.enabled AS enabled,
               ${availableExpr} AS available,
               ROW_NUMBER() OVER (
                 PARTITION BY m.model_id
                 ORDER BY ${availableExpr} DESC, m.intelligence_rank ASC, m.id ASC
               ) AS rn
        FROM models m
      )
      WHERE rn = 1
    `).all() as (ModelListRow & { intelligence_rank: number; id: number; supports_tools: number; supports_vision: number })[];
    allListed = models.map(m => ({
      id: m.model_id, name: m.display_name, ownedBy: m.platform,
      available: m.available, enabled: m.enabled, contextWindow: m.context_window,
      intel: m.intelligence_rank,
      platforms: [m.platform],
      supportsTools: m.supports_tools === 1,
      supportsVision: m.supports_vision === 1,
    }));
  }

  // Stable order: usable first, then enabled, then smartest, then name.
  allListed.sort((a, b) =>
    (b.available - a.available) || (b.enabled - a.enabled) || (a.intel - b.intel) || a.name.localeCompare(b.name));

  const availableContextWindows = allListed
    .filter(m => m.available === 1 && m.contextWindow != null)
    .map(m => m.contextWindow as number);
  const autoContextWindow = availableContextWindows.length > 0
    ? Math.max(...availableContextWindows)
    : null;

  return { models: allListed, autoContextWindow };
}

// A single entry in a model's `model_versions` array — the Claude Desktop
// Model Discovery protocol reads this to decide what a gateway can serve.
export interface ModelVersion {
  id: string;
  display_name: string;
  base_model_id: null;
  created_at: string;
  supports_vision: boolean;
  supports_tools: boolean;
}

// Build the `model_versions[0]` entry for a catalog model. Every gateway model
// has exactly one version (itself), so the array is always a singleton.
export function buildModelVersion(m: NormalizedModel): ModelVersion {
  return {
    id: m.id,
    display_name: m.name,
    base_model_id: null,
    created_at: MODEL_CREATED_AT,
    supports_vision: m.supportsVision,
    supports_tools: m.supportsTools,
  };
}

// Build a `model_versions[0]` entry for a virtual model (auto/fusion) that has
// no catalog row. Capabilities are the union of what the available pool serves.
export function buildVirtualModelVersion(
  id: string,
  displayName: string,
  supportsVision: boolean,
  supportsTools: boolean,
): ModelVersion {
  return {
    id,
    display_name: displayName,
    base_model_id: null,
    created_at: MODEL_CREATED_AT,
    supports_vision: supportsVision,
    supports_tools: supportsTools,
  };
}
