/**
 * Express router handles model fallback configuration and token budget reporting.
 * It integrates named profiles dynamically into the fallback routing logic and aggregates
 * monthly token consumption and rate limits (RPM/RPD/TPM/TPD) across configured models.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getAllPenalties, getRoutingScores, getRoutingStrategy, setRoutingStrategy, setCustomWeights } from '../services/router.js';
import { BANDIT_PRESETS, type RoutingStrategy } from '../services/scoring.js';
import { parseBudget } from '../lib/budget.js';
import { getModelGroups } from '../services/model-groups.js';
import { getPenaltyInspector } from '../services/penalty-inspector.js';

export const fallbackRouter = Router();

// ── Bandit routing strategy ─────────────────────────────────────────────────
// GET  /routing → active strategy, preset weights, and the per-model score
//                 breakdown (reliability / speed / intelligence + guardrails).
fallbackRouter.get('/routing', (_req: Request, res: Response) => {
  res.json(getRoutingScores());
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
  res.json({ strategy: getRoutingStrategy(), presets: BANDIT_PRESETS });
});

// Get fallback chain (with dynamic penalties)
fallbackRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT fc.model_db_id, fc.priority, fc.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
           m.tpm_limit, m.tpd_limit, m.context_window,
           m.monthly_token_budget, m.supports_vision, m.supports_tools,
           m.key_id, ak.label AS key_label,
           mo.overrides_json IS NOT NULL AS has_overrides
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    WHERE m.enabled = 1
    ORDER BY fc.priority ASC
  `).all() as any[];

  // Count enabled keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys WHERE enabled = 1
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
      monthlyTokenBudgetTokens: parseBudget(r.monthly_token_budget),
      supportsVision: r.supports_vision === 1,
      supportsTools: r.supports_tools === 1,
      source: r.platform === 'custom' || r.key_id != null ? 'custom' : 'catalog',
      keyId: r.key_id ?? null,
      keyLabel: r.key_label ?? null,
      hasOverrides: Boolean(r.has_overrides),
      keyCount: keyCountMap.get(r.platform) ?? 0,
    };
  }));
});

const updateSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

// Update fallback chain (full replace)
fallbackRouter.put('/', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const update = db.prepare(`
    UPDATE fallback_config SET priority = ?, enabled = ? WHERE model_db_id = ?
  `);

  const updateAll = db.transaction(() => {
    for (const entry of parsed.data) {
      update.run(entry.priority, entry.enabled ? 1 : 0, entry.modelDbId);
    }
  });
  updateAll();

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

  const update = db.prepare('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?');
  const reorder = db.transaction(() => {
    for (let i = 0; i < models.length; i++) {
      update.run(i + 1, models[i].id);
    }
  });
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
  const modelBudgets = rawModels
    .filter(m => platformSet.has(m.platform))
    .map(m => ({
      modelDbId: m.model_db_id,
      displayName: m.display_name,
      platform: m.platform,
      budget: parseBudget(m.monthly_token_budget),
      enabled: m.enabled === 1,
      rpmLimit: m.rpm_limit,
      rpdLimit: m.rpd_limit,
      tpmLimit: m.tpm_limit,
      tpdLimit: m.tpd_limit,
    }));

  // Total budget counts all models (both enabled and disabled — they contribute to the pool)
  const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0);

  // Tokens used this month
  const usage = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_used
    FROM requests
    WHERE created_at >= datetime('now', 'start of month')
      AND request_type = 'chat'
  `).get() as { total_used: number };

  res.json({
    totalBudget,
    totalUsed: usage.total_used,
    models: modelBudgets,
  });
});
