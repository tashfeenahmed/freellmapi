/**
 * GitHub Copilot plan-tier helpers.
 *
 * Driven by the `sku=...` field embedded in the short-lived session
 * token returned from `/copilot_internal/v2/token`. We don't refresh
 * tier ever — it's captured once at login. If the user upgrades their
 * Copilot plan later, they have to re-login (out of scope; a dashboard
 * "refresh tier" button is a v3 followup).
 *
 * Budget numbers are computed estimates, not GitHub-published values:
 *   budget(M) ≈ (requests/month) × 13_000 tokens/request
 *
 * 13k is a Claude-Code-shaped request: tool registry + a couple of
 * tool-call turns. Bigger turns burn more, smaller chat-only burns
 * less; the estimate is intentionally loose. The dashboard label
 * surfaces this by suffixing "(Pro est.)" / "(Student est.)" etc.
 *
 * NOTE: GitHub is moving Copilot to AI Credits on 2026-06-01 (6 days
 * after this writes). That changes the math from request-count to a
 * credit pool; the per-tier table here will need a re-think then.
 */
import type Database from 'better-sqlite3';

export type CopilotTier =
  | 'free'
  | 'pro'
  | 'pro+'
  | 'student'
  | 'business'
  | 'enterprise'
  | 'unknown';

/**
 * Map a GitHub Copilot `sku=...` token field to our tier. The exact
 * sku string values come from observed `/copilot_internal/v2/token`
 * responses; new ones can appear as GitHub renames plans (e.g.
 * `copilot_individual` was originally just the paid Pro plan).
 *
 * `copilot_student` is sometimes a standalone sku, sometimes appears
 * as the parent `copilot_individual` plus a `chat_enabled_for_student`
 * field elsewhere in the token. We match both forms.
 */
export function mapSkuToTier(sku: string, tokenField?: string): CopilotTier {
  const s = sku.toLowerCase();
  if (s === 'free') return 'free';
  if (s === 'copilot_individual_pro_plus') return 'pro+';
  if (s === 'copilot_business') return 'business';
  if (s === 'copilot_enterprise') return 'enterprise';
  if (s === 'copilot_student') return 'student';
  if (s === 'copilot_individual') {
    // The token field sometimes carries `student=true` or similar on
    // individual SKUs that have been flagged as Student Pack accounts.
    if (tokenField && /student/i.test(tokenField)) return 'student';
    return 'pro';
  }
  return 'unknown';
}

/**
 * Per-model GitHub Copilot premium-request multiplier. Static per
 * model — independent of tier. 0x = unmetered, 1x = one premium
 * request per call, 0.33x = three calls per quota unit.
 */
export function getCopilotMultiplier(modelId: string): '0x' | '0.33x' | '1x' | undefined {
  switch (modelId) {
    case 'gpt-5-mini':    return '0x';
    case 'gpt-5.4-mini':  return '0.33x';
    case 'gpt-5.2-codex': return '1x';
    default:              return undefined;
  }
}

/**
 * Monthly premium-request quota per tier — the number of "1x"
 * requests the user gets each month. Used to surface "what does
 * this multiplier mean for me" math in the dashboard tooltip.
 * Returns null for tiers where the quota is opaque (business /
 * enterprise share a per-seat allotment from a pool we can't see).
 */
export function getCopilotQuota(tier: CopilotTier): number | null {
  switch (tier) {
    case 'free':       return 50;
    case 'pro':        return 300;
    case 'student':    return 300;
    case 'pro+':       return 1500;
    case 'business':   return null;
    case 'enterprise': return null;
    case 'unknown':    return null;
  }
}

/**
 * Token budget string ("~12M", "" if disabled) for a given copilot
 * model on a given tier. Empty string means the model is gated off
 * (free tier doesn't get the premium-multiplier models, etc.).
 *
 * Sondre's primary target is gpt-5.4-mini (0.33x mult). gpt-5-mini
 * is unmetered (0x) so it gets a sentinel "~999M". gpt-5.2-codex
 * (1x) is the most expensive of the three.
 *
 * @returns budget string for the models.monthly_token_budget column,
 *          or "" if the model should be disabled for this tier.
 */
export function computeCopilotBudget(modelId: string, tier: CopilotTier): string {
  // Free tier — only the 0x model is reachable.
  if (tier === 'free') {
    if (modelId === 'gpt-5-mini') return '~999M';
    return ''; // disable gpt-5.4-mini and gpt-5.2-codex
  }

  // Pro+ — 1500 reqs/mo premium quota.
  if (tier === 'pro+') {
    if (modelId === 'gpt-5-mini')    return '~999M';
    if (modelId === 'gpt-5.4-mini')  return '~60M';  // 4500 reqs × 13k
    if (modelId === 'gpt-5.2-codex') return '~20M';  // 1500 reqs × 13k
    return '';
  }

  // Pro / Student / Business / Enterprise / Unknown — treat as 300 reqs/mo
  // for individual paid plans; org plans are opaque (no public quota
  // surface) so default to the same shape and let the dashboard surface
  // the tier so the user knows the estimate is per-seat-equivalent.
  // TODO: business/enterprise tier number needs re-thinking once we have
  // a real account to test against.
  if (modelId === 'gpt-5-mini')    return '~999M';
  if (modelId === 'gpt-5.4-mini')  return '~12M';   // 900 reqs × 13k
  if (modelId === 'gpt-5.2-codex') return '~4M';    // 300 reqs × 13k
  return '';
}

/**
 * Apply a tier to the local DB:
 *   - update models.monthly_token_budget for the 3 copilot rows
 *   - update fallback_config.enabled to disable models the tier can't
 *     reach (e.g. premium-only models on free tier)
 *
 * Idempotent — safe to call on every login.
 */
export function applyCopilotTier(db: Database.Database, tier: CopilotTier): void {
  const copilotModels = db.prepare(`
    SELECT id, model_id FROM models WHERE platform = 'github-copilot'
  `).all() as { id: number; model_id: string }[];

  const updateBudget = db.prepare('UPDATE models SET monthly_token_budget = ? WHERE id = ?');
  const setEnabled = db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?');

  const apply = db.transaction(() => {
    for (const m of copilotModels) {
      const budget = computeCopilotBudget(m.model_id, tier);
      if (budget === '') {
        // Disabled at this tier — drop the budget label and unflag in
        // fallback_config so auto-route skips it.
        updateBudget.run('Not available on this plan', m.id);
        setEnabled.run(0, m.id);
      } else {
        updateBudget.run(budget, m.id);
        setEnabled.run(1, m.id);
      }
    }
  });
  apply();
}
