/**
 * Soft budget alerts for per-key monthly caps (#1158).
 *
 * A cap that only speaks at 100% is a hard stop with no warning: an agent
 * fleet just starts seeing 429s and the operator learns about it from the
 * outage. Every comparable router grew an early-warning layer on top of its
 * caps — LiteLLM's budget_alerts / soft-budget notifications and OpenRouter's
 * per-key spend-limit alert (80% then 100% of the limit by default) are the
 * reference designs. This is the same shape on our own ledger:
 *
 *   - Thresholds: 80% and 100% of monthly_request_cap and monthly_token_cap,
 *     checked against the durable key_monthly_usage ledger the caps enforce
 *     against, so the alert and the block can never disagree.
 *   - Dedup: each (key, month, threshold, cap) fires exactly once. State lives
 *     in the settings table keyed by month, so a new UTC month re-arms the
 *     alerts for free and no pruning job is needed (one small row per capped
 *     key per month).
 *   - Destinations: a structured event in the dashboard's server-log store
 *     (Logs page, event=key_budget_threshold), which the operator already
 *     watches, plus an optional BUDGET_ALERT_WEBHOOK_URL POST (below).
 *
 * The check runs wherever a success settles into the ledger (the request-log
 * commit hook, the embedding/media/moderation/rerank/search loggers and the
 * decision logger), so it sees every served surface once per request. It is deliberately cheap on the hot path:
 * one indexed cap read, and the usage read + state write only happen once a
 * key is actually capped; the settings dedup read only after a threshold is
 * already crossed.
 */
import { getDb, getSetting, setSetting } from '../db/index.js';
import { providerLog } from '../lib/server-logs.js';
import { getMonthlyBudgetCaps, getMonthlyUsage, nextMonthResetAt } from './key-budget.js';

/** Fraction-of-cap points that produce an alert. 1.0 is the hard block; the
 *  whole point is that 0.8 fires while there is still room to act. */
export const BUDGET_ALERT_THRESHOLDS = [0.8, 1.0] as const;
export type BudgetAlertThreshold = (typeof BUDGET_ALERT_THRESHOLDS)[number];

export type BudgetCapKind = 'requests' | 'tokens';

export interface BudgetCrossing {
  threshold: BudgetAlertThreshold;
  kind: BudgetCapKind;
  /** Ledger usage at check time (requests or tokens). */
  used: number;
  /** The configured cap. */
  cap: number;
}

/**
 * Pure crossing decision: given a key's caps and current usage, which alert
 * thresholds are at or over? A cap of 0 means unlimited and never crosses.
 * Kept pure so the arithmetic is testable without a DB.
 */
export function budgetThresholdCrossings(
  caps: { requestCap: number; tokenCap: number },
  usage: { requests: number; tokens: number },
): BudgetCrossing[] {
  const crossings: BudgetCrossing[] = [];
  const consider = (kind: BudgetCapKind, used: number, cap: number) => {
    if (cap <= 0) return;
    for (const threshold of BUDGET_ALERT_THRESHOLDS) {
      if (used >= threshold * cap) crossings.push({ threshold, kind, used, cap });
    }
  };
  consider('requests', usage.requests, caps.requestCap);
  consider('tokens', usage.tokens, caps.tokenCap);
  return crossings;
}

function stateKey(keyId: number, month: string): string {
  return `budget_alerts_fired:${keyId}:${month}`;
}

function firedList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function pct(used: number, cap: number): string {
  return `${Math.floor((used / cap) * 100)}%`;
}

/**
 * Check one key against its alert thresholds and emit any alert not already
 * fired this month. Never throws: budget alerting must not break the request
 * path it observes.
 */
export function noteBudgetAlerts(keyId: number, now = Date.now()): void {
  try {
    const caps = getMonthlyBudgetCaps(keyId);
    if (caps.requestCap <= 0 && caps.tokenCap <= 0) return;

    const usage = getMonthlyUsage(keyId, now);
    const crossings = budgetThresholdCrossings(caps, usage);
    if (crossings.length === 0) return;

    const month = new Date(now).toISOString().slice(0, 7);
    const skey = stateKey(keyId, month);
    const fired = firedList(getSetting(skey));
    const fresh = crossings.filter(c => !fired.includes(`${c.kind}:${c.threshold}`));
    if (fresh.length === 0) return;

    const row = getDb()
      .prepare('SELECT label, platform FROM api_keys WHERE id = ?')
      .get(keyId) as { label: string | null; platform: string } | undefined;
    const label = row?.label ?? `key ${keyId}`;

    for (const c of fresh) {
      const hard = c.threshold >= 1;
      providerLog(
        hard ? 'warn' : 'info',
        `[budget] ${hard ? 'KEY AT CAP' : 'budget alert'}: key ${keyId} '${label}' (${row?.platform ?? '?'}) ` +
          `reached ${pct(c.used, c.cap)} of its monthly ${c.kind} cap (${c.used}/${c.cap}); ` +
          `requests ${hard ? 'are now rejected' : 'still flow'} until the reset at ${nextMonthResetAt(now)}.`,
        { event: 'key_budget_threshold', provider: row?.platform ?? undefined },
      );
    }
    setSetting(skey, JSON.stringify([...fired, ...fresh.map(c => `${c.kind}:${c.threshold}`)]));
    dispatchBudgetWebhook(keyId, label, row?.platform ?? null, fresh, now);
  } catch {
    // Alerting is observational; a failure here must never fail a request.
  }
}

// ── Webhook destination ────────────────────────────────────────────────────
//
// BUDGET_ALERT_WEBHOOK_URL (optional, read each time an alert fires): a POST
// target for the same alerts the Logs page shows — the LiteLLM
// `budget_alerts` webhook shape (Slack/Discord work via a workflow). One
// JSON body per firing batch; fire-and-forget with a short timeout; failures
// are logged once and swallowed. The URL is operator configuration, not
// caller input, so no SSRF surface is added beyond what the proxy already
// trusts (upstream provider endpoints).

export function budgetAlertWebhookUrl(): string | null {
  const raw = process.env.BUDGET_ALERT_WEBHOOK_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}

/** Build the webhook payload for one firing batch. Pure so it is testable. */
export function budgetWebhookPayload(
  keyId: number,
  label: string,
  platform: string | null,
  crossings: BudgetCrossing[],
  now = Date.now(),
) {
  return {
    type: 'freellmapi.key_budget_threshold',
    key_id: keyId,
    label,
    platform,
    month: new Date(now).toISOString().slice(0, 7),
    resets_at: nextMonthResetAt(now),
    thresholds: crossings.map(c => ({
      kind: c.kind,
      threshold: c.threshold,
      used: c.used,
      cap: c.cap,
      blocked: c.threshold >= 1,
    })),
  };
}

function dispatchBudgetWebhook(
  keyId: number,
  label: string,
  platform: string | null,
  crossings: BudgetCrossing[],
  now: number,
): void {
  const url = budgetAlertWebhookUrl();
  if (!url) return;
  // proxyFetch honours the same outbound proxy the rest of the server uses;
  // import lazily so unit tests without a DB/proxy config stay cheap.
  void import('../lib/proxy.js')
    .then(({ proxyFetch }) =>
      proxyFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(budgetWebhookPayload(keyId, label, platform, crossings, now)),
        signal: AbortSignal.timeout(10_000),
      }),
    )
    .then(res => {
      if (!res.ok) providerLog('warn', `[budget] alert webhook answered ${res.status}`, { event: 'key_budget_webhook' });
    })
    .catch(() => {
      providerLog('warn', '[budget] alert webhook delivery failed', { event: 'key_budget_webhook' });
    });
}

/** Test/admin helper: alerts fired for a key in a month (for assertions). */
export function firedBudgetAlerts(keyId: number, now = Date.now()): string[] {
  const month = new Date(now).toISOString().slice(0, 7);
  return firedList(getSetting(stateKey(keyId, month)));
}
