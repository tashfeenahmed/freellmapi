import type { AttemptRecord } from './fallback-loop.js';

export type BaseBlockCause = 'cooldown' | 'provider_limit' | 'key_quota' | 'chain_exhausted';
export type BlockCause = 'vision_quota_exhausted' | BaseBlockCause;

export interface BlockCauseResult {
  cause: BlockCause;
  detail?: BaseBlockCause;
}

const CONFIG_LINE = /no provider registered|no enabled\+healthy key|no usable key|decrypt-error|no-resolved-provider|custom-key-mismatch/;
const REASON_LINE = /^(.+?):\s*\d+\s+key\(s\)\s—\s+(.*)$/;
const REASON = /^([^:]+):\d+$/;

const PROVIDER_LIMIT_REASONS: ReadonlySet<string> = new Set([
  'provider-daily-cap', 'provider-minute-cap', 'provider-daily-token-cap', 'cloudflare-neuron-cap', 'checkin-required',
]);
const KEY_QUOTA_REASONS: ReadonlySet<string> = new Set([
  'rpm/rpd-limit', 'tpm/tpd-limit', 'monthly-budget-cap', 'key-concurrency',
]);
const IGNORED_REASONS: ReadonlySet<string> = new Set([
  'already-failed-this-request', 'decrypt-error', 'custom-key-mismatch', 'no-resolved-provider', 'no usable key',
]);

type Family = BaseBlockCause | 'other';

function reasonFamily(reason: string): Family | undefined {
  if (reason === 'cooldown') return 'cooldown';
  if (PROVIDER_LIMIT_REASONS.has(reason)) return 'provider_limit';
  if (KEY_QUOTA_REASONS.has(reason)) return 'key_quota';
  if (IGNORED_REASONS.has(reason)) return undefined;
  return 'other';
}

function attemptFamily(errorClass: AttemptRecord['errorClass']): Family {
  // An upstream 429 benches that key on a cooldown (cooldownDecisionForError),
  // so this request's 429 attempt and the next request's `cooldown:N` router
  // line are the same state. Reporting provider_limit here made the first
  // request say provider_limit and the retry say cooldown, and turned the
  // common "one key 429'd, the rest were already cooling" into chain_exhausted.
  if (errorClass === 'rate_limited') return 'cooldown';
  if (errorClass === 'daily_quota_exhausted' || errorClass === 'out_of_credits' || errorClass === 'forbidden') return 'key_quota';
  return 'other';
}

function onlyFamily(families: ReadonlySet<Family>): BaseBlockCause {
  if (families.size === 1 && !families.has('other')) return [...families][0] as BaseBlockCause;
  return 'chain_exhausted';
}

type LineClass = 'ignored' | 'config' | Family[];

// Single decision per line, shared by baseBlockCause and blockCause,
// so "config line" has one definition. Key line with all ignored tokens is config.
function classifyLine(line: string): LineClass {
  const lower = line.toLowerCase();
  if (lower.includes('ruled out earlier')) return 'ignored';

  const match = REASON_LINE.exec(line);
  if (!match) return CONFIG_LINE.test(lower) ? 'config' : ['other'];

  const families: Family[] = [];
  for (const token of match[2].split(', ')) {
    const reason = REASON.exec(token)?.[1] ?? token;
    const family = reasonFamily(reason);
    if (family) families.push(family);
  }
  return families.length === 0 ? 'config' : families;
}

export function baseBlockCause(diag: readonly string[], attempts: readonly AttemptRecord[]): BaseBlockCause {
  const families = new Set<Family>();

  for (const line of diag) {
    const classified = classifyLine(line);
    if (classified === 'ignored' || classified === 'config') continue;
    for (const family of classified) families.add(family);
  }

  for (const attempt of attempts) families.add(attemptFamily(attempt.errorClass));

  return onlyFamily(families);
}

export function blockCause(input: {
  status: number;
  requireVision: boolean;
  diag?: readonly string[];
  attempts: readonly AttemptRecord[];
}): BlockCauseResult | undefined {
  if (input.status !== 429) return undefined;

  const diag = input.diag ?? [];
  const noVision = (line: string) => line.toLowerCase().includes('no vision support');


  // With requireVision, the vision line is filtered out first;
  // without it, such a line is `other` for the base. The detail is the base cause,
  // no adjustment: chain_exhausted remains chain_exhausted.
  const diagForBase = input.requireVision ? diag.filter(l => !noVision(l)) : diag;
  const cause = baseBlockCause(diagForBase, input.attempts);

  return input.requireVision
    ? { cause: 'vision_quota_exhausted', detail: cause }
    : { cause };
}
