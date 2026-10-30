// Free-only routing: keep automatic routing on providers whose free access is
// documented, and never let a request reach a destination that could bill the
// operator unless they opted in.
//
// Two modes, decided by the caller:
//  - 'automatic' — the router chose the model (auto, a named chain, a model
//    group, a failover hop, an auto-picked fusion slot). Eligible only when the
//    provider is 'free-recurring' or 'free-model-subset', the model passes its
//    free rule, the evidence is at least 'medium', and the provider is not
//    recorded as training on prompts. Unknown or low-confidence pricing is
//    ineligible.
//  - 'explicit' — the client named the model (or pinned it in a fusion config,
//    or pressed "Test" in the dashboard). Allowed for documented free access
//    of any confidence, trial keys and the operator's own custom endpoints,
//    none of which can bill. Blocked for credit-based, promotional, paid,
//    paid-beyond-free, retired and unknown destinations, and for models a free
//    rule excludes.
//
// Opt-in:
//   FREE_ONLY_ROUTING=off                      disables the guard entirely
//   FREE_ONLY_ALLOW_PLATFORMS=sail,custom      treats these platforms as allowed
//                                              in both modes (warned at startup)
//
// Configuration is read on every call (cheap) so tests and restarts see the
// current environment; warnings are emitted once per distinct value.
import {
  getProviderMetadata, modelFreeStatus, type FreeTierClass, type ProviderMetadata,
} from '../providers/metadata.js';

export type RoutingMode = 'automatic' | 'explicit';

export interface FreeOnlyDecision {
  allowed: boolean;
  /** Short human-readable reason when blocked; safe to log and return. */
  reason?: string;
}

const ALLOWED: FreeOnlyDecision = { allowed: true };

const AUTOMATIC_CLASSES: ReadonlySet<FreeTierClass> = new Set(['free-recurring', 'free-model-subset']);
// Explicit requests may also use access that cannot bill the operator.
const EXPLICIT_EXTRA_CLASSES: ReadonlySet<FreeTierClass> = new Set(['trial', 'operator-managed']);

const PLATFORM_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function isFreeOnlyEnabled(): boolean {
  const raw = (process.env.FREE_ONLY_ROUTING ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no', 'disabled'].includes(raw);
}

export function optedInPlatforms(): Set<string> {
  const raw = process.env.FREE_ONLY_ALLOW_PLATFORMS ?? '';
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim().toLowerCase();
    if (id && PLATFORM_ID.test(id)) out.add(id);
  }
  return out;
}

function blocked(reason: string): FreeOnlyDecision {
  return { allowed: false, reason };
}

function hint(platform: string): string {
  return `set FREE_ONLY_ALLOW_PLATFORMS=${platform} to opt in`;
}

export function automaticDecision(meta: ProviderMetadata, modelId: string): FreeOnlyDecision {
  if (meta.freeTier === 'operator-managed') {
    return blocked(`custom endpoint, cost set by its operator; ${hint(meta.platform)}`);
  }
  if (!AUTOMATIC_CLASSES.has(meta.freeTier)) return blocked(`${meta.freeTier} access; ${hint(meta.platform)}`);
  if (meta.trainsOnPrompts) return blocked(`provider logs prompts for training; ${hint(meta.platform)}`);
  if (meta.confidence === 'low') return blocked(`free tier not documented well enough; ${hint(meta.platform)}`);
  const status = modelFreeStatus(meta, modelId);
  if (status === 'not-free') return blocked(`model is outside the provider's free models; ${hint(meta.platform)}`);
  if (status === 'unknown') return blocked(`no rule identifies this model as free; ${hint(meta.platform)}`);
  return ALLOWED;
}

export function explicitDecision(meta: ProviderMetadata, modelId: string): FreeOnlyDecision {
  if (EXPLICIT_EXTRA_CLASSES.has(meta.freeTier)) return ALLOWED;
  if (!AUTOMATIC_CLASSES.has(meta.freeTier)) return blocked(`${meta.freeTier} access; ${hint(meta.platform)}`);
  const status = modelFreeStatus(meta, modelId);
  if (status === 'free') return ALLOWED;
  return blocked(`${status === 'unknown' ? 'model not identified as free' : "model is outside the provider's free models"}; ${hint(meta.platform)}`);
}

/** The single entry point the router uses. */
export function freeOnlyDecision(platform: string, modelId: string, mode: RoutingMode): FreeOnlyDecision {
  if (!isFreeOnlyEnabled()) return ALLOWED;
  if (optedInPlatforms().has(platform.toLowerCase())) return ALLOWED;
  const meta = getProviderMetadata(platform);
  return mode === 'explicit' ? explicitDecision(meta, modelId) : automaticDecision(meta, modelId);
}

export interface FreeOnlyPolicySummary {
  enabled: boolean;
  optedIn: Array<{ platform: string; freeTier: FreeTierClass; warning: string | null }>;
}

const WARN_CLASSES: ReadonlySet<FreeTierClass> = new Set([
  'paid', 'paid-beyond-free', 'free-recurring-credit', 'promotional', 'retired', 'unknown', 'operator-managed',
]);

function optInWarning(meta: ProviderMetadata): string | null {
  if (meta.trainsOnPrompts) return 'logs prompts for training';
  if (WARN_CLASSES.has(meta.freeTier)) return `${meta.freeTier} access can consume credit or be billed`;
  if (meta.confidence === 'low') return 'free tier not documented well enough';
  return null;
}

export function freeOnlyPolicySummary(): FreeOnlyPolicySummary {
  return {
    enabled: isFreeOnlyEnabled(),
    optedIn: [...optedInPlatforms()].sort().map(platform => {
      const meta = getProviderMetadata(platform);
      return { platform, freeTier: meta.freeTier, warning: optInWarning(meta) };
    }),
  };
}

let lastWarned = '';

/** Logs the effective policy once per distinct configuration (startup and changes). */
export function warnFreeOnlyPolicy(log: (msg: string) => void = console.warn): void {
  const summary = freeOnlyPolicySummary();
  const signature = JSON.stringify(summary);
  if (signature === lastWarned) return;
  lastWarned = signature;
  if (!summary.enabled) {
    log('[free-only] FREE_ONLY_ROUTING is off: automatic routing may use paid, credit-based or unverified providers');
    return;
  }
  for (const entry of summary.optedIn) {
    if (entry.warning) log(`[free-only] ${entry.platform} is opted in via FREE_ONLY_ALLOW_PLATFORMS: ${entry.warning}`);
  }
}
