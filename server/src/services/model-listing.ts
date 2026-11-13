import type { ModelListRow } from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';
import { isUnifyEnabled, getModelGroups } from './model-groups.js';
import { hasUsableKeyForModel } from './router.js';

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
  // Dynamic execution status for agents: `ready` (a key can serve it right
  // now), `needsKey` (disabled, or no enabled key matches it — available=0's
  // breakdown), or `exhausted` (keys exist but every one is currently blocked,
  // so a request would fail immediately).
  executionStatus: 'ready' | 'needsKey' | 'exhausted';
}

export interface ModelListing {
  // Full catalog, sorted usable-first; callers apply their own `available` filter.
  models: NormalizedModel[];
  // Honest ceiling for the virtual "auto" model: the largest context window
  // among models that can serve a request right now (null when nothing is
  // connected). Computed over available models regardless of any caller filter.
  autoContextWindow: number | null;
}

// `ready` — at least one key could actually serve a request for this model
// right now: enabled, healthy or never probed (probing is lazy, so an unprobed
// key counts as usable), not scoped away from the model (#657), not on
// cooldown, and inside its rate and token windows. `exhausted` — keys match
// the model but every one of them is currently blocked, so a request would
// fail straight away. `needsKey` — nothing matches it at all, or the model is
// disabled.
//
// The gates are the router's own (hasOtherUsableKey), deliberately rather than
// a second reading of api_keys.status: a live 429 never writes that column, it
// writes a cooldown row (see services/ratelimit.ts, lib/fallback-loop.ts), so
// status alone reports a cooling-down model as ready.
function executionStatusFor(modelDbIds: number[], available: number): 'ready' | 'needsKey' | 'exhausted' {
  if (available !== 1) return 'needsKey';
  return modelDbIds.some(id => hasUsableKeyForModel(id)) ? 'ready' : 'exhausted';
}

/**
 * The context window to ADVERTISE for an entry the router can serve from
 * several models (auto, fusion, a named chain, a unify group): the largest
 * window that most of those models hold, i.e. the upper median, not the max.
 * Clients size their context to this number (OpenClaw compacts against it),
 * and advertising the single biggest window meant one 1M model made `auto`
 * claim 1M, so sessions grew until every request carried 500k+ tokens that
 * most of the pool rejects (#1717). Larger requests still route: the router's
 * size gates send them to the models that can hold them.
 */
export function servableContextWindow(windows: readonly (number | null | undefined)[]): number | null {
  const known = windows.filter((w): w is number => typeof w === 'number' && w > 0).sort((a, b) => b - a);
  if (known.length === 0) return null;
  return known[Math.floor(known.length / 2)]!;
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
    type AvailRow = { id: number; platform: string; intelligence_rank: number; context_window: number | null; enabled: number; available: number; supports_tools: number };
    const rows = db.prepare(`
      SELECT m.id, m.platform, m.intelligence_rank, m.context_window, m.supports_tools,
             m.enabled AS enabled, ${availableExpr} AS available
      FROM models m
    `).all() as AvailRow[];
    const byId = new Map(rows.map(r => [r.id, r]));
    allListed = getModelGroups().map(g => {
      const infos = g.members.map(m => byId.get(m.model_db_id)).filter(Boolean) as AvailRow[];
      const available = infos.some(i => i.available === 1) ? 1 : 0;
      return {
        id: g.canonicalId,
        name: g.groupLabel,
        ownedBy: 'freellmapi',
        available,
        enabled: infos.some(i => i.enabled === 1) ? 1 : 0,
        contextWindow: servableContextWindow(infos.map(i => i.context_window)),
        intel: infos.length ? Math.min(...infos.map(i => i.intelligence_rank)) : Number.MAX_SAFE_INTEGER,
        platforms: [...new Set(infos.map(i => i.platform))],
        supportsTools: infos.some(i => i.supports_tools === 1),
        // A group is ready when ANY member can serve it — that is exactly the
        // choice the router has when it dispatches the group.
        executionStatus: executionStatusFor(g.members.map(m => m.model_db_id), available),
      };
    });
  } else {
    // Unify OFF: one entry per model_id (dedup picks the available, smartest
    // representative row).
    const models = db.prepare(`
      SELECT platform, model_id, display_name, context_window, enabled, available, intelligence_rank, id, supports_tools
      FROM (
        SELECT m.platform, m.model_id, m.display_name, m.context_window, m.intelligence_rank, m.id, m.supports_tools,
               m.enabled AS enabled,
               ${availableExpr} AS available,
               ROW_NUMBER() OVER (
                 PARTITION BY m.model_id
                 ORDER BY ${availableExpr} DESC, m.intelligence_rank ASC, m.id ASC
               ) AS rn
        FROM models m
      )
      WHERE rn = 1
    `).all() as (ModelListRow & { intelligence_rank: number; id: number; supports_tools: number })[];
    allListed = models.map(m => ({
      id: m.model_id, name: m.display_name, ownedBy: m.platform,
      available: m.available, enabled: m.enabled, contextWindow: m.context_window,
      intel: m.intelligence_rank,
      platforms: [m.platform],
      supportsTools: m.supports_tools === 1,
      executionStatus: executionStatusFor([m.id], m.available),
    }));
  }

  // Stable order: usable first, then enabled, then smartest, then name.
  allListed.sort((a, b) =>
    (b.available - a.available) || (b.enabled - a.enabled) || (a.intel - b.intel) || a.name.localeCompare(b.name));

  const autoContextWindow = servableContextWindow(
    allListed.filter(m => m.available === 1).map(m => m.contextWindow),
  );

  return { models: allListed, autoContextWindow };
}
