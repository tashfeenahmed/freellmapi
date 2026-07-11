import { z } from 'zod';
import type { ChatMessage, ChatCompletionChoice, ChatCompletionResponse, ChatToolCall, TokenUsage } from '@freellmapi/shared/types.js';
import {
  routePinnedModel, routeRequest, getOrderedFusionChain, resolveFusionCandidate,
  recordRateLimitHit, recordSuccess, type RouteResult, type FusionCandidate,
} from './router.js';
import {
  recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit,
  PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_FORBIDDEN_COOLDOWN_MS,
} from './ratelimit.js';
import { logRequest } from '../lib/request-log.js';
import {
  isRetryableError, isPaymentRequiredError,
  isModelNotFoundError, isModelAccessForbiddenError,
} from '../lib/error-classify.js';
import { contentToString } from '../lib/content.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { getSetting, setSetting } from '../db/index.js';
import type { CompletionOptions } from '../providers/base.js';

// The virtual model id that triggers multi-model synthesis. Mirrors how
// `auto` is a virtual id the router intercepts (see routes/proxy.ts).
export const FUSION_MODEL_ID = 'fusion';

export function isFusionModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return lower === FUSION_MODEL_ID || lower.startsWith(`${FUSION_MODEL_ID}:`);
}

// Tag every panel/judge sub-call with this in the request log so fusion traffic
// is attributable in analytics exactly like a pinned model would be.
const FUSION_TAG = 'fusion';

// Panel sizing. Default is deliberately ABOVE OpenRouter's 3-model default —
// the whole point of running on free tiers is we can afford a wider, more
// diverse panel. Both are operator-overridable via settings so a deployment
// can dial the token multiplier up or down without a code change.
const DEFAULT_PANEL_K = 4;
const HARD_MAX_PANEL_K = 8; // ceiling even an explicit panel can't exceed
// A panel of fewer than this many *successful* answers isn't worth a judge
// pass — with one survivor we just return it directly.
const SYNTHESIS_QUORUM = 2;
// Per-slot key-rotation budget: a slot tries at most this many keys of its
// pinned model before it's dropped. Small — a model with every key cooled down
// should fail fast, not stall the whole panel.
const MAX_SLOT_ATTEMPTS = 4;
// Judge dispatch walks the normal auto chain; give it room to fail over.
const MAX_JUDGE_ATTEMPTS = 6;

function intSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function panelDefaultK(): number {
  return Math.min(intSetting('fusion_default_k', DEFAULT_PANEL_K), panelMaxK());
}
function panelMaxK(): number {
  return Math.min(intSetting('fusion_max_k', HARD_MAX_PANEL_K), HARD_MAX_PANEL_K);
}

export const fusionConfigSchema = z.object({
  // Explicit panel: the exact model ids the client wants to fuse. Any unknown
  // / disabled ids are dropped (and reported in x_fusion) rather than failing
  // the whole request — a panel is robust to missing members by design.
  models: z.array(z.string().min(1)).optional(),
  // Auto-panel size when `models` is omitted. Clamped to [1, fusion_max_k].
  k: z.number().int().positive().optional(),
  // Judge/synthesizer model id. Omit → the top-ranked available model.
  judge: z.string().min(1).optional(),
  // 'synthesize' (default): one blended answer. 'best_of': skip the judge,
  // return the longest single panel answer (cheaper; no +1 judge call).
  strategy: z.enum(['synthesize', 'best_of']).optional(),
  // Attach the per-model panel answers + judge metadata under `x_fusion`.
  expose_panel: z.boolean().optional(),
});

export type FusionConfig = z.infer<typeof fusionConfigSchema>;

export function getFusionMaxK(): number {
  return panelMaxK();
}

// ── Saved fusion config (dashboard-managed default) ─────────────────────────
// Persisted in the settings table under `fusion_config`. A request's inline
// `fusion` field always overrides the saved default field-by-field, so the UI
// sets the baseline and any client can still tweak per call. `mode` is the
// "Both, user-toggleable" toggle: 'auto' picks a diverse panel off the
// Fallback Chain (ignoring `models`); 'explicit' uses the saved `models` list.
const SAVED_FUSION_KEY = 'fusion_config';

export const savedFusionConfigSchema = z.object({
  mode: z.enum(['auto', 'explicit']),
  models: z.array(z.string().min(1)).default([]),
  judge: z.string().min(1).nullable().default(null),
  k: z.number().int().positive(),
  strategy: z.enum(['synthesize', 'best_of']),
  expose_panel: z.boolean(),
});

export type SavedFusionConfig = z.infer<typeof savedFusionConfigSchema>;

function defaultSavedConfig(): SavedFusionConfig {
  return { mode: 'auto', models: [], judge: null, k: panelDefaultK(), strategy: 'synthesize', expose_panel: false };
}

export function getSavedFusionConfig(): SavedFusionConfig {
  const raw = getSetting(SAVED_FUSION_KEY);
  if (raw) {
    try {
      const parsed = savedFusionConfigSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch { /* corrupt setting → fall through to default */ }
  }
  return defaultSavedConfig();
}

export function setSavedFusionConfig(input: SavedFusionConfig): SavedFusionConfig {
  const maxK = panelMaxK();
  const normalized: SavedFusionConfig = {
    mode: input.mode,
    // De-dup the explicit panel and clamp to the operator cap.
    models: [...new Set(input.models)].slice(0, maxK),
    judge: input.judge && input.judge.trim() ? input.judge.trim() : null,
    k: Math.min(Math.max(input.k, 1), maxK),
    strategy: input.strategy,
    expose_panel: input.expose_panel,
  };
  setSetting(SAVED_FUSION_KEY, JSON.stringify(normalized));
  return normalized;
}

/**
 * Merge a request's inline fusion config over the saved dashboard default.
 * Each field present on the request wins; otherwise the saved default applies.
 * An explicit panel only comes from the saved config when its mode is
 * 'explicit' — in 'auto' mode the saved `models` are ignored so the panel is
 * picked fresh off the Fallback Chain.
 */
export function resolveEffectiveConfig(req: FusionConfig): FusionConfig {
  const saved = getSavedFusionConfig();
  const models = (req.models && req.models.length > 0)
    ? req.models
    : (saved.mode === 'explicit' && saved.models.length > 0 ? saved.models : undefined);
  return {
    models,
    k: req.k ?? saved.k,
    judge: req.judge ?? saved.judge ?? undefined,
    strategy: req.strategy ?? saved.strategy,
    expose_panel: req.expose_panel ?? saved.expose_panel,
  };
}

// One panel member's outcome.
interface PanelAnswer {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  status: 'ok' | 'failed';
  content?: string;
  toolCalls?: ChatToolCall[];
  rawChoice?: ChatCompletionChoice;
  error?: string;
  usage?: TokenUsage;
}

interface CallOutcome {
  ok: boolean;
  route?: RouteResult;
  text?: string;
  toolCalls?: ChatToolCall[];
  rawChoice?: ChatCompletionChoice;
  usage?: TokenUsage;
  error?: string;
}

const ZERO_USAGE: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + (b.prompt_tokens ?? 0),
    completion_tokens: a.completion_tokens + (b.completion_tokens ?? 0),
    total_tokens: a.total_tokens + (b.total_tokens ?? 0),
  };
}

/**
 * Run one model call with retry across keys/models, doing the same accounting
 * (request counts, token usage, success/penalty, cooldowns, request log) the
 * normal proxy path does — just tagged as fusion traffic. `getRoute` decides
 * WHICH model is tried: a pinned-model closure for a panel slot (never
 * substitutes), or the auto-router for the judge (falls over across the chain).
 */
async function runModelCall(
  getRoute: (skipKeys: Set<string>, skipModels: Set<number>) => RouteResult | null,
  messages: ChatMessage[],
  options: CompletionOptions,
  estimatedTokens: number,
  maxAttempts: number,
): Promise<CallOutcome> {
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let route: RouteResult | null;
    try {
      route = getRoute(skipKeys, skipModels);
    } catch (err: any) {
      // routeRequest throws when the whole chain is exhausted (judge path).
      lastError = sanitizeProviderErrorMessage(err?.message);
      break;
    }
    if (!route) break;

    const startedAt = Date.now();
    try {
      const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, options);
      const choice = result.choices?.[0];
      const text = contentToString(choice?.message?.content ?? '');
      const toolCalls = choice?.message?.tool_calls;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

      if (!text && !hasToolCalls) {
        // Empty completion — fail over like the main proxy path does.
        logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, 'empty completion (fusion)', null, FUSION_TAG);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
        recordRateLimitHit(route.modelDbId);
        lastError = `empty completion from ${route.displayName}`;
        continue;
      }

      const usage = result.usage ?? ZERO_USAGE;
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, usage.total_tokens);
      recordSuccess(route.modelDbId);
      logRequest(route.platform, route.modelId, route.keyId, 'success', usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, Date.now() - startedAt, null, null, FUSION_TAG);
      return {
        ok: true,
        route,
        text,
        toolCalls: hasToolCalls ? toolCalls : undefined,
        rawChoice: hasToolCalls ? choice : undefined,
        usage,
      };
    } catch (err: any) {
      const safe = sanitizeProviderErrorMessage(err?.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, safe, null, FUSION_TAG);
      lastError = safe;

      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(
          route.platform, route.modelId, route.keyId,
          isPaymentRequiredError(err)
            ? PAYMENT_REQUIRED_COOLDOWN_MS
            : isModelAccessForbiddenError(err)
            ? MODEL_FORBIDDEN_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }, err.retryAfterMs),
        );
        recordRateLimitHit(route.modelDbId);
        continue;
      }
      // Non-retryable (auth, validation) — this slot/judge is done.
      break;
    }
  }

  return { ok: false, error: lastError ?? 'no available key for model' };
}

/**
 * Like runModelCall, but STREAMS the judge's answer so the client sees it
 * written live instead of waiting for the whole synthesis. Failover only works
 * before the first byte (`started`): once we've forwarded text to the client we
 * can't cleanly switch models, so a mid-stream error returns the partial answer.
 * Usage is estimated (streaming rarely echoes a usage block).
 */
async function runJudgeStreaming(
  getRoute: (skipKeys: Set<string>, skipModels: Set<number>) => RouteResult | null,
  messages: ChatMessage[],
  options: CompletionOptions,
  estimatedTokens: number,
  maxAttempts: number,
  cb: { onStart?: (r: { platform: string; model: string }) => void; onDelta?: (t: string) => void },
): Promise<CallOutcome> {
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let route: RouteResult | null;
    try { route = getRoute(skipKeys, skipModels); } catch (err: any) { lastError = sanitizeProviderErrorMessage(err?.message); break; }
    if (!route) break;

    const startedAt = Date.now();
    let text = '';
    let started = false;
    try {
      for await (const chunk of route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, options)) {
        const delta = (chunk as any)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          if (!started) { started = true; cb.onStart?.({ platform: route.platform, model: route.modelId }); }
          text += delta;
          cb.onDelta?.(delta);
        }
      }
      if (!text) {
        logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, 'empty completion (fusion judge)', null, FUSION_TAG);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
        recordRateLimitHit(route.modelDbId);
        lastError = `empty judge completion from ${route.displayName}`;
        continue;
      }
      const out = Math.ceil(text.length / 4);
      const usage: TokenUsage = { prompt_tokens: estimatedTokens, completion_tokens: out, total_tokens: estimatedTokens + out };
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, usage.total_tokens);
      recordSuccess(route.modelDbId);
      logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedTokens, out, Date.now() - startedAt, null, null, FUSION_TAG);
      return { ok: true, route, text, usage };
    } catch (err: any) {
      const safe = sanitizeProviderErrorMessage(err?.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, safe, null, FUSION_TAG);
      lastError = safe;
      // Already streamed bytes — can't fail over without duplicating output.
      // Keep whatever the client already received.
      if (started) {
        if (text) {
          const out = Math.ceil(text.length / 4);
          return { ok: true, route, text, usage: { prompt_tokens: estimatedTokens, completion_tokens: out, total_tokens: estimatedTokens + out } };
        }
        break;
      }
      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(
          route.platform, route.modelId, route.keyId,
          isPaymentRequiredError(err) ? PAYMENT_REQUIRED_COOLDOWN_MS
            : isModelAccessForbiddenError(err) ? MODEL_FORBIDDEN_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }, err.retryAfterMs),
        );
        recordRateLimitHit(route.modelDbId);
        continue;
      }
      break;
    }
  }
  return { ok: false, error: lastError ?? 'no available key for judge' };
}

/**
 * Collapse a provider-specific model id to its rough model FAMILY: drop the
 * provider prefix (everything up to the last '/') and any ':tag'/':free' suffix,
 * so e.g. `qwen/qwen3-coder:free` and `qwen3-coder:480b` map to one family.
 * Deliberately a SIMPLE heuristic, not a maintained alias map — cross-provider
 * id naming drifts constantly, so we only want a good-enough signal to avoid
 * stacking the panel with the same model served under two providers.
 */
export function familyKey(modelId: string): string {
  return modelId.toLowerCase().replace(/^.*\//, '').replace(/:.*$/, '');
}

/**
 * Order a strategy-sorted servable chain for panel diversity along TWO axes:
 * provider (platform) AND model family. Fusion's value comes from genuinely
 * DIFFERENT perspectives (issue #326 spike: a panel only beats the best single
 * model when its members actually disagree); the same model family served by
 * two providers is platform-distinct but perspective-redundant — one viewpoint
 * filling two slots.
 *
 * Two stable passes, each preserving the routing-strategy order it's handed:
 *  1. Provider-first (the existing invariant): one model per distinct platform
 *     before doubling up, so the panel spans different backends / failure
 *     domains.
 *  2. Family-dedup: within that provider-diverse order, demote any model whose
 *     family already appeared — a fresh family takes the slot first, and the
 *     redundant copy sinks to the refill tail rather than being dropped.
 * Pure function of its input (unit-tested directly).
 */
export function diversifyChain(ordered: FusionCandidate[]): FusionCandidate[] {
  // Pass 1 — provider diversity first, strategy order within.
  const seenPlatform = new Set<string>();
  const platformFirst: FusionCandidate[] = [];
  const platformRest: FusionCandidate[] = [];
  for (const c of ordered) {
    if (seenPlatform.has(c.platform)) platformRest.push(c);
    else { seenPlatform.add(c.platform); platformFirst.push(c); }
  }
  // Pass 2 — demote same-family duplicates so a fresh perspective wins the slot.
  const seenFamily = new Set<string>();
  const fresh: FusionCandidate[] = [];
  const dupFamily: FusionCandidate[] = [];
  for (const c of [...platformFirst, ...platformRest]) {
    const fam = familyKey(c.modelId);
    if (seenFamily.has(fam)) dupFamily.push(c);
    else { seenFamily.add(fam); fresh.push(c); }
  }
  return [...fresh, ...dupFamily];
}

/**
 * Build the panel plus a refill queue:
 *  - `panel`    — the K models to run first (explicit list, or provider-diverse
 *                 picks off the strategy-sorted chain).
 *  - `overflow` — the next servable models from the chain, used to refill a slot
 *                 when a panel model fails outright (auto mode only; an explicit
 *                 panel is run as-is with no substitution).
 * Diversity = distinct provider AND model family first (see diversifyChain), so
 * both the panel and its refills span genuinely different perspectives before
 * doubling up on either axis.
 */
function selectPanel(config: FusionConfig, requirements: { requireTools?: boolean } = {}): { panel: FusionCandidate[]; overflow: FusionCandidate[]; dropped: string[] } {
  const maxK = panelMaxK();

  if (config.models && config.models.length > 0) {
    const panel: FusionCandidate[] = [];
    const dropped: string[] = [];
    const seen = new Set<number>();
    for (const id of config.models) {
      if (panel.length >= maxK) { dropped.push(`${id} (over cap of ${maxK})`); continue; }
      const cand = resolveFusionCandidate(id);
      if (!cand) { dropped.push(`${id} (unknown or disabled)`); continue; }
      if (requirements.requireTools && !cand.supportsTools) { dropped.push(`${id} (no tool-calling support)`); continue; }
      if (seen.has(cand.modelDbId)) continue; // de-dup repeats
      seen.add(cand.modelDbId);
      panel.push(cand);
    }
    // Explicit panel: the user named exact models, so don't substitute others.
    return { panel, overflow: [], dropped };
  }

  const k = Math.min(Math.max(config.k ?? panelDefaultK(), 1), maxK);
  const ordered = getOrderedFusionChain().filter(c => !requirements.requireTools || c.supportsTools);

  // Diversity-first ordering of the whole servable chain along provider AND
  // model family (see diversifyChain). The first K are the panel; the rest are
  // refill candidates that stay as diverse as possible.
  const full = diversifyChain(ordered);

  const panel = full.slice(0, k);
  // Cap refills so a run of failures can't sweep the entire catalog: try at most
  // K extra models (≤ 2K dispatches total).
  const overflow = full.slice(k, k * 2);
  return { panel, overflow, dropped: [] };
}

// Synthesis judge instructions. Anonymized "Response N" so the judge weighs
// content, not model reputation; told to produce the final answer directly with
// no meta-commentary about merging.
const JUDGE_SYSTEM_PROMPT =
  'You are the final author of a single answer. Several AI assistants each independently answered the user\'s most recent message; their answers are provided below, anonymized as "Response 1", "Response 2", etc. ' +
  'IMPORTANT: the user will NEVER see any of those individual responses — they only ever see what you write — so your answer must be COMPLETE and fully STAND-ALONE on its own. ' +
  'Take the best parts of every response, combine the correct and most useful ideas into one coherent whole, resolve any contradictions by reasoning about which is actually right (do not just average or list options), and fill in anything they all missed. ' +
  'Then REWRITE it all from scratch, in your own words, as one clear, well-structured, self-contained answer that makes complete sense by itself. ' +
  'Do not mention that other answers exist, do not refer to "Response 1/2/3", do not compare the responses, and do not describe your process — just deliver the final, authoritative answer directly to the user.';

function buildJudgeMessages(original: ChatMessage[], answers: PanelAnswer[]): ChatMessage[] {
  const ok = answers.filter(a => a.status === 'ok' && a.content);
  const panelBlock = ok
    .map((a, i) => `--- Response ${i + 1} ---\n${a.content}`)
    .join('\n\n');

  // Keep the full original conversation for context, then append the candidate
  // answers + synthesis instruction as a final user turn. The judge system
  // prompt leads so it frames everything that follows.
  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    ...original,
    {
      role: 'user',
      content:
        `Here are ${ok.length} independent answers to my most recent message:\n\n${panelBlock}\n\n` +
        'Take the best parts of these, then rewrite one complete, self-contained answer to my most recent message in your own words. ' +
        'I will only see your answer — not these — so do not reference them.',
    },
  ];
}

export interface FusionResult {
  response: ChatCompletionResponse & { x_fusion?: unknown };
  routedVia: string; // for the X-Routed-Via header
}

/**
 * Orchestrate a fusion request end to end: select the panel, fan out in
 * parallel, then synthesize survivors with a judge (or best-of). Throws a
 * FusionError when nothing usable comes back so the route can map it to an
 * HTTP status.
 */
export class FusionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Progress hooks for a streaming fusion request. Fired as each panel slot
// settles and when the judge succeeds, so a client (the Playground) can show the
// panel answers arriving and the judge kicking in before the final answer.
export interface FusionHooks {
  onPanel?: (a: { platform: string; model: string; status: 'ok' | 'failed'; content?: string; tool_calls?: ChatToolCall[]; error?: string }) => void;
  onJudge?: (j: { platform: string; model: string }) => void;
  // When set, the judge STREAMS: onJudge fires at the first token (so the trace
  // shows the judge model) and onJudgeDelta fires for each token, so the final
  // answer is written live instead of appearing all at once after the wait.
  onJudgeDelta?: (text: string) => void;
}

export async function runFusion(params: {
  messages: ChatMessage[];
  config: FusionConfig;
  options: CompletionOptions;
  estimatedTokens: number;
  hooks?: FusionHooks;
}): Promise<FusionResult> {
  const { messages, options, estimatedTokens, hooks } = params;
  // Apply the dashboard-saved default; the request's inline fusion field (if
  // any) has already-merged precedence field-by-field.
  const config = resolveEffectiveConfig(params.config);
  const strategy = config.strategy ?? 'synthesize';

  const requireTools = (options.tools?.length ?? 0) > 0;
  const { panel, overflow, dropped } = selectPanel(config, { requireTools });
  if (panel.length === 0) {
    throw new FusionError(
      'fusion: no usable models for the panel. Provide `fusion.models` with enabled model ids, or enable models in the Fallback Chain.',
      400,
    );
  }

  // Dispatch ONE panel slot: hard-pinned to its model, rotating only that
  // model's keys (so a key 429 doesn't collapse the slot onto a duplicate
  // backend — issue #326). Returns its answer and fires onPanel the moment it
  // settles so a streaming client sees answers arrive one by one.
  const runSlot = (cand: FusionCandidate): Promise<PanelAnswer> =>
    runModelCall(
      (skipKeys) => routePinnedModel(cand.modelDbId, estimatedTokens, skipKeys),
      messages, options, estimatedTokens, MAX_SLOT_ATTEMPTS,
    ).then((outcome): PanelAnswer => {
      const answer: PanelAnswer = outcome.ok
        ? {
            modelDbId: cand.modelDbId,
            platform: cand.platform,
            modelId: cand.modelId,
            displayName: cand.displayName,
            status: 'ok',
            content: outcome.text,
            toolCalls: outcome.toolCalls,
            rawChoice: outcome.rawChoice,
            usage: outcome.usage,
          }
        : { modelDbId: cand.modelDbId, platform: cand.platform, modelId: cand.modelId, displayName: cand.displayName, status: 'failed', error: outcome.error };
      hooks?.onPanel?.({ platform: answer.platform, model: answer.modelId, status: answer.status, content: answer.content, tool_calls: answer.toolCalls, error: answer.error });
      return answer;
    });

  // Run the panel in waves, REFILLING failed slots from the fallback chain:
  // we aim for `target` successful answers. Wave 1 is the K-model panel; if some
  // fail (a model 429s/413s/aborts), the next wave pulls that many more models
  // from `overflow` (the next servable models in your chain). A slot is never
  // substituted mid-model — we move to a DIFFERENT chain model — so diversity
  // holds while transient failures don't shrink the panel. Bounded by the
  // candidate pool (≤ 2K dispatches), so it can't sweep the whole catalog.
  const target = panel.length;
  const candidates = [...panel, ...overflow];
  const answers: PanelAnswer[] = [];
  let okCount = 0;
  let cursor = 0;
  while (okCount < target && cursor < candidates.length) {
    const wave = candidates.slice(cursor, cursor + (target - okCount));
    cursor += wave.length;
    const settled = await Promise.allSettled(wave.map(runSlot));
    settled.forEach((s, i) => {
      const a: PanelAnswer = s.status === 'fulfilled'
        ? s.value
        : { modelDbId: wave[i].modelDbId, platform: wave[i].platform, modelId: wave[i].modelId, displayName: wave[i].displayName, status: 'failed', error: sanitizeProviderErrorMessage((s as PromiseRejectedResult).reason?.message) };
      answers.push(a);
      if (a.status === 'ok' && (a.content || (a.toolCalls?.length ?? 0) > 0)) okCount++;
    });
  }

  const survivors = answers.filter(a => a.status === 'ok' && (a.content || (a.toolCalls?.length ?? 0) > 0));
  let totalUsage: TokenUsage = { ...ZERO_USAGE };
  for (const a of survivors) totalUsage = addUsage(totalUsage, a.usage);

  if (survivors.length === 0) {
    throw new FusionError(
      'fusion: every panel model failed or was rate-limited. Try again shortly or pick different `fusion.models`.',
      429,
    );
  }

  // Tool calls are actions, not prose. They cannot be safely synthesized across
  // models, so the first panel survivor that returned structured tool_calls
  // wins and the judge is skipped.
  const toolCallWinner = survivors.find(a => (a.toolCalls?.length ?? 0) > 0 && a.rawChoice);
  if (toolCallWinner) {
    const choice: ChatCompletionChoice = {
      index: 0,
      message: toolCallWinner.rawChoice!.message,
      finish_reason: 'tool_calls',
    };
    const response: ChatCompletionResponse & { x_fusion?: unknown; _fusion?: unknown } = {
      id: `fusion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: FUSION_MODEL_ID,
      choices: [choice],
      usage: totalUsage,
    };
    const winner = { platform: toolCallWinner.platform, model: toolCallWinner.modelId };
    response._fusion = {
      panel: survivors.map(a => ({ platform: a.platform, model: a.modelId })),
      judge: null,
      synthesized: false,
      tool_call_winner: winner,
    };

    if (config.expose_panel) {
      response.x_fusion = {
        strategy,
        synthesized: false,
        judge: null,
        panel_requested: panel.map(p => p.modelId),
        dropped,
        tool_call_winner: winner,
        panel: answers.map(a => ({
          model: a.modelId,
          platform: a.platform,
          status: a.status,
          ...(a.status === 'ok'
            ? { content: a.content, tool_calls: a.toolCalls }
            : { error: a.error }),
        })),
      };
    }

    return {
      response,
      routedVia: `fusion(${survivors.map(a => a.modelId).join('+')} -> tool_call:${toolCallWinner.modelId})`,
    };
  }

  const textSurvivors = survivors.filter(a => a.content);

  // Decide the final answer.
  let finalText: string;
  let judgeModelLabel: string | null = null;
  let judgeRoute: { platform: string; model: string } | null = null;
  let synthesized = false;

  if (textSurvivors.length < SYNTHESIS_QUORUM || strategy === 'best_of') {
    // One survivor, or best-of requested: return the strongest single answer
    // (longest as a cheap proxy for completeness) — no judge call.
    finalText = textSurvivors.slice().sort((a, b) => (b.content!.length - a.content!.length))[0].content!;
  } else {
    const judgeMessages = buildJudgeMessages(messages, textSurvivors);
    // The judge prompt carries every panel answer, so its input is much larger
    // than the original — size the routing estimate accordingly.
    const judgeEstimate = estimatedTokens + textSurvivors.reduce((n, a) => n + Math.ceil((a.content?.length ?? 0) / 4), 0);
    const judgeOptions: CompletionOptions = requireTools
      ? { ...options, tools: undefined, tool_choice: undefined, parallel_tool_calls: undefined }
      : options;

    const getJudgeRoute = config.judge
      ? (skipKeys: Set<string>) => {
          const cand = resolveFusionCandidate(config.judge!);
          return cand ? routePinnedModel(cand.modelDbId, judgeEstimate, skipKeys) : null;
        }
      : (skipKeys: Set<string>, skipModels: Set<number>) => routeRequest(judgeEstimate, skipKeys.size ? skipKeys : undefined, undefined, false, false, skipModels.size ? skipModels : undefined);

    // Stream the judge when the caller wants live tokens (Playground); otherwise
    // a single buffered call (plain API clients hitting fusion non-streaming).
    const judge = hooks?.onJudgeDelta
      ? await runJudgeStreaming(getJudgeRoute, judgeMessages, judgeOptions, judgeEstimate, MAX_JUDGE_ATTEMPTS, {
          // Surface the judge model the moment it starts emitting, so the trace
          // shows it while the answer is still streaming.
          onStart: (r) => { judgeRoute = r; judgeModelLabel = `${r.platform}/${r.model}`; hooks.onJudge?.(r); },
          onDelta: hooks.onJudgeDelta,
        })
      : await runModelCall(getJudgeRoute, judgeMessages, judgeOptions, judgeEstimate, MAX_JUDGE_ATTEMPTS);

    if (judge.ok && judge.text) {
      finalText = judge.text;
      synthesized = true;
      // For the streaming path judgeRoute was set in onStart; set it here for the
      // buffered path (and as a fallback).
      if (!judgeRoute && judge.route) judgeRoute = { platform: judge.route.platform, model: judge.route.modelId };
      judgeModelLabel = judgeRoute ? `${judgeRoute.platform}/${judgeRoute.model}` : null;
      if (!hooks?.onJudgeDelta && judgeRoute) hooks?.onJudge?.(judgeRoute);
      totalUsage = addUsage(totalUsage, judge.usage);
    } else {
      // Judge failed → best-of fallback rather than erroring the whole request.
      finalText = textSurvivors.slice().sort((a, b) => (b.content!.length - a.content!.length))[0].content!;
    }
  }

  const routedModels = textSurvivors.map(a => a.modelId);
  const routedVia = `fusion(${routedModels.join('+')}${synthesized && judgeModelLabel ? ` -> ${judgeModelLabel}` : ''})`;

  const response: ChatCompletionResponse & { x_fusion?: unknown; _fusion?: unknown } = {
    id: `fusion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: FUSION_MODEL_ID,
    choices: [{ index: 0, message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
    usage: totalUsage,
  };

  // Lightweight, always-on routing summary so a client (e.g. the Playground
  // footer) can show exactly which panel models replied and which judge
  // synthesized — without the heavier per-answer `x_fusion` payload.
  response._fusion = {
    panel: survivors.map(a => ({ platform: a.platform, model: a.modelId })),
    judge: synthesized ? judgeRoute : null,
    synthesized,
  };

  if (config.expose_panel) {
    response.x_fusion = {
      strategy,
      synthesized,
      judge: judgeModelLabel,
      panel_requested: panel.map(p => p.modelId),
      dropped,
      panel: answers.map(a => ({
        model: a.modelId,
        platform: a.platform,
        status: a.status,
        ...(a.status === 'ok' ? { content: a.content } : { error: a.error }),
      })),
    };
  }

  return { response, routedVia };
}
