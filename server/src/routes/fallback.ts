/**
 * Express router handles model fallback configuration and token budget reporting.
 * It integrates named profiles dynamically into the fallback routing logic and aggregates
 * monthly token consumption and rate limits (RPM/RPD/TPM/TPD) across configured models.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties, getRoutingScores, getRoutingStrategy, setRoutingStrategy, setCustomWeights, getExploreEnabled, setExploreEnabled, getPeakHoursConfig, setPeakHoursConfig, getActiveRoutingWeights, getKeySelectionStrategy, setKeySelectionStrategy } from '../services/router.js';
import { BANDIT_PRESETS, isValidTimezone, type RoutingStrategy } from '../services/scoring.js';
import { parseBudget } from '../lib/budget.js';
import { getModelGroups } from '../services/model-groups.js';
import { getPenaltyInspector } from '../services/penalty-inspector.js';
import { getActiveProfileId } from '../services/profile-models.js';
import { qualifiedModelMemberId } from '../lib/endpoint-scope.js';
import { overriddenFieldNames } from '../services/model-state.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';

export const fallbackRouter = Router();

// ── Bandit routing strategy ─────────────────────────────────────────────────
// GET  /routing → active strategy, preset weights, and the per-model score
//                 breakdown (reliability / speed / intelligence + guardrails).
fallbackRouter.get('/routing', (_req: Request, res: Response) => {
  const { peakHours, ...rest } = getRoutingScores();
  res.json({
    ...rest,
    peakHoursAdjust: peakHours.enabled,
    peakStartHour: peakHours.startHour,
    peakEndHour: peakHours.endHour,
    peakTimezone: peakHours.timezone,
  });
});

fallbackRouter.get('/penalty-inspector', (_req: Request, res: Response) => {
  res.json(getPenaltyInspector());
});

const routingSchema = z.object({
  strategy: z.enum(['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom']),
  // Only meaningful with strategy 'custom': the user's weight vector. Any
  // non-negative vector is accepted; setCustomWeights renormalizes to sum 1.
  weights: z.object({
    reliability: z.number().nonnegative(),
    speed: z.number().nonnegative(),
    intelligence: z.number().nonnegative(),
  }).optional(),
  // Exploration toggle: give unmeasured models a guaranteed chance to be tried.
  exploreEnabled: z.boolean().optional(),
  // Peak-hours adjustment (#760), off by default. Hours are whole numbers in
  // 0-23 and are read in `peakTimezone`, never the server's local clock, so the
  // window means the same thing on a UTC container as on the operator's laptop.
  peakHoursAdjust: z.boolean().optional(),
  peakStartHour: z.number().int().min(0).max(23, { message: 'peakStartHour must be an integer between 0 and 23' }).optional(),
  peakEndHour: z.number().int().min(0).max(23, { message: 'peakEndHour must be an integer between 0 and 23' }).optional(),
  peakTimezone: z.string().refine(isValidTimezone, { message: 'peakTimezone must be a valid IANA timezone name' }).optional(),
  // How to pick between several keys of one platform (#919). Independent of
  // `strategy`, which ranks MODELS — the two are set from the same form, so
  // they round-trip through the same request.
  keySelectionStrategy: z.enum(['auto', 'least-remaining']).optional(),
});

// PUT /routing → switch strategy. Presets are just weight vectors over the three
// axes; 'priority' falls back to the legacy manual chain order; 'custom' uses
// the user's saved weights (optionally updated in the same request).
fallbackRouter.put('/routing', (req: Request, res: Response) => {
  const parsed = routingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  // Persist the weights before flipping the strategy so the new mode reads the
  // intended vector immediately. setCustomWeights throws on an all-zero vector.
  if (parsed.data.weights) {
    try {
      setCustomWeights(parsed.data.weights);
    } catch (err: any) {
      res.status(400).json({ error: { message: err?.message ?? 'Invalid custom weights' } });
      return;
    }
  }
  setRoutingStrategy(parsed.data.strategy as RoutingStrategy);
  if (parsed.data.exploreEnabled !== undefined) {
    setExploreEnabled(parsed.data.exploreEnabled);
  }
  if (parsed.data.keySelectionStrategy !== undefined) {
    setKeySelectionStrategy(parsed.data.keySelectionStrategy);
  }
  try {
    setPeakHoursConfig({
      enabled: parsed.data.peakHoursAdjust,
      startHour: parsed.data.peakStartHour,
      endHour: parsed.data.peakEndHour,
      timezone: parsed.data.peakTimezone,
    });
  } catch (err: any) {
    res.status(400).json({ error: { message: err?.message ?? 'Invalid peak-hours settings' } });
    return;
  }
  // `presets` is the raw preset table (unchanged); `weights` is what the router
  // will actually use right now, which differs from the preset while the
  // peak-hours adjustment is firing. Returning both keeps the echo honest
  // without breaking clients that read `presets` (#760).
  const active = getActiveRoutingWeights();
  const peak = getPeakHoursConfig();
  res.json({
    strategy: getRoutingStrategy(),
    exploreEnabled: getExploreEnabled(),
    keySelectionStrategy: getKeySelectionStrategy(),
    presets: BANDIT_PRESETS,
    weights: active.weights,
    peakAdjusted: active.adjusted,
    peakHoursAdjust: peak.enabled,
    peakStartHour: peak.startHour,
    peakEndHour: peak.endHour,
    peakTimezone: peak.timezone,
  });
});

// The catalog columns every fallback row carries, whichever table supplies the
// priority/enabled pair. Kept in one place so the profile and the no-profile
// query can never drift apart.
const MODEL_COLUMNS = `
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit, m.context_window,
           m.monthly_token_budget, m.supports_vision, m.supports_tools,
           m.key_id, m.endpoint_scope, ak.label AS key_label,
           mo.overrides_json IS NOT NULL AS has_overrides,
           mo.overrides_json,
           ts.source AS tombstone_source, ts.reason AS tombstone_reason`;

const MODEL_JOINS = `
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    LEFT JOIN catalog_model_tombstones ts
      ON ts.kind = 'chat' AND ts.platform = m.platform AND ts.model_id = m.model_id`;

// The whole catalog seen THROUGH one chain (#1021). A chain is a set of opt-ins,
// not a copy of the catalog: a model the chain names keeps the priority and the
// on/off flag stored against it, and a model it does not name is still listed —
// switched OFF, ranked after everything the chain does name. That is what makes
// a hand-built ("start empty") chain usable at all: it renders as "the catalog,
// nothing turned on yet" instead of an empty page, and turning a row on is the
// PUT below, which writes the row into the chain. Nothing is persisted by GET.
const PROFILE_CHAIN_SQL = `
    SELECT m.id AS model_db_id, pm.priority AS chain_priority, pm.enabled AS chain_enabled,
           fc.priority AS catalog_priority,
${MODEL_COLUMNS}
    FROM models m
    LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
${MODEL_JOINS}
    WHERE m.enabled = 1
`;

const GLOBAL_CHAIN_SQL = `
    SELECT fc.model_db_id, fc.priority, fc.enabled,
${MODEL_COLUMNS}
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
${MODEL_JOINS}
    WHERE m.enabled = 1
    ORDER BY fc.priority ASC
`;

/**
 * Order a chain-scoped catalog read and give every row a priority.
 *
 * Rows the chain names come first, in their stored order and keeping their
 * stored numbers. Rows it does not name follow in catalog order, numbered after
 * the last stored one, so the list stays monotonic and stable between reads
 * without writing anything back.
 */
function orderProfileRows(rows: any[]): any[] {
  const inChain = rows.filter(r => r.chain_priority != null);
  const rest = rows.filter(r => r.chain_priority == null);
  inChain.sort((a, b) => a.chain_priority - b.chain_priority || a.model_db_id - b.model_db_id);
  rest.sort((a, b) =>
    (a.catalog_priority ?? Number.MAX_SAFE_INTEGER) - (b.catalog_priority ?? Number.MAX_SAFE_INTEGER)
    || a.model_db_id - b.model_db_id);

  const maxStored = inChain.length ? inChain[inChain.length - 1].chain_priority : 0;
  return [
    ...inChain.map(r => ({ ...r, priority: r.chain_priority, enabled: r.chain_enabled })),
    ...rest.map((r, i) => ({ ...r, priority: maxStored + 1 + i, enabled: 0 })),
  ];
}

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  // #1047: an explicit ?profile= pins the read to that chain, so a client
  // caching per-chain can never have "the active chain, whichever that is right
  // now" written into a specific chain's cache entry. During an activation the
  // active id changes between the client's two fetches; that race is how chain
  // B's rows ended up rendered (and nearly saved) under chain A's name.
  let activeProfileId = getActiveProfileId(db);
  const requestedRaw = req.query.profile;
  if (requestedRaw !== undefined) {
    const requested = Number.parseInt(String(requestedRaw), 10);
    if (!Number.isInteger(requested) || requested <= 0
      || !db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(requested)) {
      res.status(404).json({ error: { message: `no such profile: ${String(requestedRaw)}` } });
      return;
    }
    activeProfileId = requested;
  }
  // `fallback_config` is the chain only for an install that has no profiles at
  // all. Once one is active it is authoritative even when it is empty — falling
  // through to the global table there is what made two different empty chains
  // show (and save) the same configuration (#1021).
  const rows = activeProfileId != null
    ? orderProfileRows(db.prepare(PROFILE_CHAIN_SQL).all(activeProfileId) as any[])
    : db.prepare(GLOBAL_CHAIN_SQL).all() as any[];

  // Count usable keys per platform — enabled AND healthy/unknown status. Unified
  // with /token-usage and the routing scorer (#456) so budget pooling is computed
  // from the same key set everywhere (a disabled or invalid key adds no capacity).
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')
    GROUP BY platform
  `).all() as { platform: string; count: number }[];
  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  // Get current dynamic penalties
  const penalties = getAllPenalties();
  const penaltyMap = new Map(penalties.map(p => [p.modelDbId, p]));

  // Logical-model grouping per row, so the dashboard can collapse the same
  // model served by several providers into one expandable group. Always sent
  // (cheap); the client renders grouped only when its unify toggle is on.
  const groupByDbId = new Map<number, { groupKey: string; canonicalId: string; groupLabel: string }>();
  for (const g of getModelGroups()) {
    for (const m of g.members) {
      groupByDbId.set(m.model_db_id, { groupKey: g.groupKey, canonicalId: g.canonicalId, groupLabel: g.groupLabel });
    }
  }

  res.json(rows.map(r => {
    const penalty = penaltyMap.get(r.model_db_id);
    const group = groupByDbId.get(r.model_db_id);
    return {
      modelDbId: r.model_db_id,
      groupKey: group?.groupKey,
      canonicalId: group?.canonicalId,
      groupLabel: group?.groupLabel,
      priority: r.priority,
      effectivePriority: r.priority + (penalty?.penalty ?? 0),
      penalty: penalty?.penalty ?? 0,
      rateLimitHits: penalty?.count ?? 0,
      enabled: r.enabled === 1,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      intelligenceRank: r.intelligence_rank,
      speedRank: r.speed_rank,
      sizeLabel: r.size_label,
      rpmLimit: r.rpm_limit,
      rpdLimit: r.rpd_limit,
      tpmLimit: r.tpm_limit,
      tpdLimit: r.tpd_limit,
      // Max context length (tokens), used by the dashboard catalog filter. Null
      // for models whose context window the catalog doesn't record.
      contextWindow: r.context_window,
      monthlyTokenBudget: r.monthly_token_budget,
      // Parsed once here (single source of truth) so the dashboard never re-implements
      // budget-label parsing; 0 for rate-limited/placeholder labels. See lib/budget.ts.
      // Scaled by healthy/enabled key count for multi-account pooled capacity.
      monthlyTokenBudgetTokens: parseBudget(r.monthly_token_budget) * Math.max(1, keyCountMap.get(r.platform) ?? 1),
      supportsVision: r.supports_vision === 1,
      supportsTools: r.supports_tools === 1,
      source: r.platform === 'custom' || r.key_id != null ? 'custom' : 'catalog',
      keyId: r.key_id ?? null,
      keyLabel: r.key_label ?? null,
      // Which relay endpoint a custom row belongs to, and the id that names it
      // unambiguously (#651). Null for catalog models only — every custom row
      // bound to an endpoint carries both, including a lone one. Deciding when
      // they are worth showing is the client's job (see memberProviderLabel /
      // providerPinId / memberEndpointTitle): it reveals them only where two
      // endpoints actually serve the same model id.
      endpointScope: r.endpoint_scope || null,
      qualifiedModelId: qualifiedModelMemberId(r.platform, r.model_id, r.endpoint_scope),
      hasOverrides: Boolean(r.has_overrides),
      // Which fields the local override actually replaces, so the model page
      // can mark the individual inputs it edits (#551).
      overrideFields: overriddenFieldNames(r.overrides_json),
      // Why the switch is off: a model auto-disabled because the provider
      // retired it upstream (410 / end of life, #634) is a different state from
      // one the user turned off, and the dashboard says so. The reason is the
      // provider's own (redacted) wording.
      retiredUpstream: r.tombstone_source === 'upstream_eol',
      retiredReason: r.tombstone_source === 'upstream_eol' ? (r.tombstone_reason ?? null) : null,
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

/**
 * Model ids that actually exist, so a stale row in a client's snapshot cannot
 * turn an INSERT into a foreign-key failure (the old UPDATE simply matched
 * nothing).
 */
function knownModelIds(db: ReturnType<typeof getDb>): Set<number> {
  return new Set((db.prepare('SELECT id FROM models').all() as { id: number }[]).map(m => m.id));
}

// Update fallback chain (full replace)
fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const activeProfileId = getActiveProfileId(db);

  // Writing to the active chain UPSERTS: the row may not be in the chain yet,
  // which is the normal state of every model in a hand-built one. The old
  // UPDATE-only write is why an empty chain could never gain its first model —
  // and why, having matched nothing, the edit was quietly redirected into the
  // single global table shared by every chain (#1021).
  const writeAll = activeProfileId != null
    ? (() => {
        const known = knownModelIds(db);
        const upsert = db.prepare(`
          INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(profile_id, model_db_id)
          DO UPDATE SET priority = excluded.priority, enabled = excluded.enabled
        `);
        return db.transaction(() => {
          for (const entry of parsed.data) {
            if (!known.has(entry.modelDbId)) continue;
            upsert.run(activeProfileId, entry.modelDbId, entry.priority, entry.enabled ? 1 : 0);
          }
        });
      })()
    : (() => {
        const update = db.prepare('UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?');
        return db.transaction(() => {
          for (const entry of parsed.data) update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
        });
      })();
  writeAll();

  res.json({ success: true });
});

// `intelligence_rank` is scoped to each provider's own catalog — a provider's
// #1 model is not globally #1 (see issue #135: MiniMax's top model outranking
// Gemini Pro because both read "Intel #1"). `size_label` IS a cross-provider
// capability tier, so normalize on it first and use intelligence_rank only as
// an in-tier tiebreaker. Unknown labels sort last.
const INTELLIGENCE_TIER =
  "CASE m.size_label WHEN 'Frontier' THEN 1 WHEN 'Large' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Small' THEN 4 ELSE 5 END";

// Sort presets — `orderBy` is selected from a fixed whitelist, never from
// user input directly, so the interpolation below is safe.
const SORT_PRESETS: Record<string, string> = {
  intelligence: `${INTELLIGENCE_TIER} ASC, m.intelligence_rank ASC`,
  speed: 'm.speed_rank ASC',
};

function getBudgetScore(m: { monthly_token_budget: string; tpd_limit: number | null }): number {
  if (m.tpd_limit != null) return m.tpd_limit * 30;
  
  const str = m.monthly_token_budget;
  if (!str) return 0;
  if (str.toLowerCase().includes('unlimited') || str.includes('∞')) return Infinity;
  
  const cleanStr = str.split('(')[0];
  const matches = cleanStr.match(/[\d.]+/g);
  let maxNum = 0;
  if (matches) {
    maxNum = Math.max(...matches.map(mStr => parseFloat(mStr)));
  }
  
  let mult = 1;
  const upper = cleanStr.toUpperCase();
  if (upper.includes('B')) mult = 1_000_000_000;
  else if (upper.includes('M')) mult = 1_000_000;
  else if (upper.includes('K')) mult = 1_000;

  return maxNum * mult;
}

fallbackRouter.post('/sort/:preset', (req: Request, res: Response) => {
  const preset = String(req.params.preset);
  const db = getDb();
  let models: { id: number }[] = [];
  const activeProfileId = getActiveProfileId(db);

  if (preset === 'budget') {
    const allModels = db.prepare(`SELECT id, monthly_token_budget, tpd_limit FROM models`).all() as any[];
    allModels.sort((a, b) => getBudgetScore(b) - getBudgetScore(a));
    models = allModels.map(m => ({ id: m.id }));
  } else {
    const orderBy = SORT_PRESETS[preset];
    if (!orderBy) {
      res.status(400).json({ error: { message: `Unknown preset: ${preset}. Use: intelligence, speed, budget` } });
      return;
    }
    models = db.prepare(`SELECT m.id FROM models m ORDER BY ${orderBy}`).all() as { id: number }[];
  }

  // Same upsert story as the PUT above: a preset sorts the list the dashboard
  // shows, which is the whole catalog seen through the chain, so a model the
  // chain has not named yet gets its row written here too — switched OFF, the
  // state it was displayed in. Sorting must never enable anything; a row
  // already in the chain keeps whatever flag it had.
  const reorder = activeProfileId != null
    ? (() => {
        const upsert = db.prepare(`
          INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(profile_id, model_db_id) DO UPDATE SET priority = excluded.priority
        `);
        return db.transaction(() => {
          for (let i = 0; i < models.length; i++) upsert.run(activeProfileId, models[i].id, i + 1);
        });
      })()
    : (() => {
        const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
        return db.transaction(() => {
          for (let i = 0; i < models.length; i++) update.run(i + 1, models[i].id);
        });
      })();
  reorder();

  res.json({ success: true, preset });
});

// Token usage per model for the stacked bar
fallbackRouter.get('/token-usage', (_req: Request, res: Response) => {
  const db = getDb();

  // Get platforms that have enabled keys
  const platforms = db.prepare(`
    SELECT DISTINCT ak.platform
    FROM api_keys ak
    WHERE ak.enabled = 1
  `).all() as { platform: string }[];
  const platformSet = new Set(platforms.map(p => p.platform));

  // Check if there is an active profile
  const settingRow = db.prepare(`SELECT value FROM settings WHERE key = 'active_profile_id'`).get() as { value: string } | undefined;
  const activeProfileId = settingRow ? (parseInt(settingRow.value) || null) : null;

  // Verify active profile still exists
  const activeProfile = activeProfileId
    ? db.prepare('SELECT id FROM profiles WHERE id = ?').get(activeProfileId) as any
    : null;

  let rawModels: { model_db_id: number; platform: string; model_id: string; display_name: string; monthly_token_budget: string; priority: number; enabled: number; rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null }[];

  if (activeProfile) {
    // Profile mode: use profile_models chain (all models in profile, checked against enabled)
    rawModels = db.prepare(`
      SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
             pm.priority, pm.enabled,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
      WHERE pm.profile_id = ? AND m.enabled = 1
      ORDER BY pm.priority ASC
    `).all(activeProfileId) as any[];
  } else {
    // Default mode: use fallback_config (only include enabled models)
    rawModels = db.prepare(`
      SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.monthly_token_budget,
             fc.priority, fc.enabled,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      WHERE m.enabled = 1
      ORDER BY fc.priority ASC
    `).all() as any[];
  }

  // Build per-model breakdown (only platforms with keys), preserving enabled state
  const usageRows = db.prepare(`
    SELECT platform, model_id, COALESCE(SUM(input_tokens + output_tokens), 0) AS used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
      AND request_type = 'chat'
    GROUP BY platform, model_id
  `).all() as { platform: string; model_id: string; used: number }[];
  const usageByModel = new Map(usageRows.map(r => [`${r.platform}:${r.model_id}`, r.used]));

  const keyCountMap = new Map(
    (db.prepare("SELECT platform, COUNT(*) as count FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown') GROUP BY platform").all() as { platform: string; count: number }[])
      .map(k => [k.platform, k.count])
  );

  const modelBudgets = rawModels
    .filter(m => platformSet.has(m.platform))
    .map(m => {
      const keys = Math.max(1, keyCountMap.get(m.platform) ?? 1);
      return {
        modelDbId: m.model_db_id,
        displayName: m.display_name,
        platform: m.platform,
        modelId: m.model_id,
        budget: parseBudget(m.monthly_token_budget) * keys,
        used: usageByModel.get(`${m.platform}:${m.model_id}`) ?? 0,
        enabled: m.enabled === 1,
        rpmLimit: m.rpm_limit,
        rpdLimit: m.rpd_limit,
        tpmLimit: m.tpm_limit,
        tpdLimit: m.tpd_limit,
      };
    });

  // Total budget counts all models (both enabled and disabled — they contribute to the pool)
  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);
  const totalUsed = modelBudgets.reduce((s, m) => s + m.used, 0);

  res.json({
    totalBudget,
    totalUsed,
    models: modelBudgets,
  });
});

// Per-model time-window rate-limit usage (RPM/RPD/TPM: used vs limit), for the
// dashboard's remaining-quota display (#876). The monthly-budget metric says
// nothing about windowed limits, so this surfaces what the router actually
// enforces.
//
// Which key's numbers to report matters. The badge answers "how close is this
// model to being unroutable", so it has to follow the key the router would pick
// NEXT, not the worst key on the account: a platform with one exhausted key and
// one idle key routes fine, and reporting the exhausted one paints a red badge
// over a model that is wide open. So we mirror the router's key eligibility
// (`selectKeyForModel`) — enabled + healthy/unknown, model scope allows this
// model (#657), and for a custom model the key must belong to the model's own
// endpoint (#212, #619) — and then report the ELIGIBLE key with the most
// headroom (lowest used/limit ratio across its windows), which is the key the
// router lands on once the busier ones fail their gates.
//
// Cost: the naive shape is three SQL counts per model × key, which is thousands
// of statements on a real catalog. All of it comes from one table, so the whole
// page is a single grouped scan of `rate_limit_usage` over the last day.
const RATE_LIMIT_MINUTE_MS = 60 * 1000;
const RATE_LIMIT_DAY_MS = 24 * 60 * RATE_LIMIT_MINUTE_MS;

interface KeyUsage { rpm: number; rpd: number; tpm: number }
const NO_USAGE: KeyUsage = { rpm: 0, rpd: 0, tpm: 0 };

/** used/limit for one window, or null when the model has no such limit. */
function windowRatio(used: number, limit: number | null): number | null {
  if (limit == null || limit <= 0) return null;
  return used / limit;
}

/** The busiest window of one key: what would reject this key's next request. */
function keyPressure(usage: KeyUsage, limits: { rpm: number | null; rpd: number | null; tpm: number | null }): number {
  let worst = 0;
  for (const r of [
    windowRatio(usage.rpm, limits.rpm),
    windowRatio(usage.rpd, limits.rpd),
    windowRatio(usage.tpm, limits.tpm),
  ]) {
    if (r !== null && r > worst) worst = r;
  }
  return worst;
}

fallbackRouter.get('/rate-limit-usage', (_req: Request, res: Response) => {
  const db = getDb();
  const now = Date.now();

  const models = db.prepare(`
    SELECT id AS model_db_id, platform, model_id, key_id, rpm_limit, rpd_limit, tpm_limit
      FROM models
     WHERE enabled = 1
  `).all() as Array<{
    model_db_id: number;
    platform: string;
    model_id: string;
    key_id: number | null;
    rpm_limit: number | null;
    rpd_limit: number | null;
    tpm_limit: number | null;
  }>;

  // Every key row once: the routable pool needs enabled+healthy rows, while the
  // custom-endpoint pool is keyed on base_url and has to resolve a model's own
  // key_id even when that row is disabled.
  const allKeys = db.prepare(`
    SELECT id, platform, base_url, model_scope_json, enabled, status FROM api_keys
  `).all() as Array<{
    id: number;
    platform: string;
    base_url: string | null;
    model_scope_json: string | null;
    enabled: number;
    status: string;
  }>;

  const baseUrlByKeyId = new Map(allKeys.map(k => [k.id, k.base_url]));
  const routableByPlatform = new Map<string, Array<{ id: number; baseUrl: string | null; scope: Set<string> | null }>>();
  for (const k of allKeys) {
    if (k.enabled !== 1 || (k.status !== 'healthy' && k.status !== 'unknown')) continue;
    const list = routableByPlatform.get(k.platform) ?? [];
    list.push({ id: k.id, baseUrl: k.base_url, scope: parseModelScope(k.model_scope_json) });
    routableByPlatform.set(k.platform, list);
  }

  // One grouped scan replaces three counts per model × key. Same windows the
  // ratelimit service enforces: a sliding minute for RPM/TPM, a sliding day for
  // RPD. Rows older than a day are pruned on write, but the WHERE keeps this
  // correct even if a prune has not run yet.
  const usageRows = db.prepare(`
    SELECT platform, model_id, key_id,
           SUM(CASE WHEN kind = 'request' AND created_at_ms > ? THEN 1 ELSE 0 END) AS rpm_used,
           SUM(CASE WHEN kind = 'request' THEN 1 ELSE 0 END) AS rpd_used,
           SUM(CASE WHEN kind = 'tokens' AND created_at_ms > ? THEN tokens ELSE 0 END) AS tpm_used
      FROM rate_limit_usage
     WHERE created_at_ms > ?
     GROUP BY platform, model_id, key_id
  `).all(now - RATE_LIMIT_MINUTE_MS, now - RATE_LIMIT_MINUTE_MS, now - RATE_LIMIT_DAY_MS) as Array<{
    platform: string; model_id: string; key_id: number;
    rpm_used: number; rpd_used: number; tpm_used: number;
  }>;
  const usageByKey = new Map<string, KeyUsage>();
  for (const u of usageRows) {
    usageByKey.set(`${u.platform}\u0000${u.model_id}\u0000${u.key_id}`, {
      rpm: u.rpm_used, rpd: u.rpd_used, tpm: u.tpm_used,
    });
  }

  const rows = models.map(m => {
    const limits = { rpm: m.rpm_limit, rpd: m.rpd_limit, tpm: m.tpm_limit };
    const pool = routableByPlatform.get(m.platform) ?? [];
    // A custom model belongs to one endpoint; only that endpoint's credentials
    // can serve it. Legacy rows (key_id NULL) keep the any-key match.
    const endpointBaseUrl = m.platform === 'custom' && m.key_id != null
      ? baseUrlByKeyId.get(m.key_id) ?? null
      : null;

    let best: KeyUsage | null = null;
    let bestPressure = Infinity;
    for (const k of pool) {
      if (!scopeAllows(k.scope, m.model_id)) continue;
      if (m.platform === 'custom' && m.key_id != null) {
        if (endpointBaseUrl == null ? k.id !== m.key_id : k.baseUrl !== endpointBaseUrl) continue;
      }
      const usage = usageByKey.get(`${m.platform}\u0000${m.model_id}\u0000${k.id}`) ?? NO_USAGE;
      const pressure = keyPressure(usage, limits);
      if (pressure < bestPressure) {
        bestPressure = pressure;
        best = usage;
      }
    }

    // No routable key at all: the model cannot be served, and a usage number
    // would be fiction. Report no windows so the dashboard shows no badge.
    if (!best) {
      return { modelDbId: m.model_db_id, platform: m.platform, modelId: m.model_id, rpm: null, rpd: null, tpm: null };
    }
    return {
      modelDbId: m.model_db_id,
      platform: m.platform,
      modelId: m.model_id,
      rpm: m.rpm_limit != null ? { used: best.rpm, limit: m.rpm_limit } : null,
      rpd: m.rpd_limit != null ? { used: best.rpd, limit: m.rpd_limit } : null,
      tpm: m.tpm_limit != null ? { used: best.tpm, limit: m.tpm_limit } : null,
    };
  });

  res.json({ generatedAtMs: now, rows });
});
