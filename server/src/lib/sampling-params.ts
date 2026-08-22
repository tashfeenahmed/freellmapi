// Extended sampling / output-shape parameters forwarded to providers.
//
// Until now only temperature / max_tokens / top_p / stop reached upstream —
// everything else a client sent (seed, penalties, logit_bias, logprobs,
// response_format…) was validated away by the request schema and silently
// dropped, so "OpenAI-compatible" was quietly narrower than it claimed
// (structured outputs simply did not work). This module is the single source
// of truth for the extended set:
//
//   - the zod fields each surface spreads into its request schema,
//   - the pick helper that turns a parsed body into CompletionOptions fields,
//   - the per-platform support policy (which params a provider is known to
//     reject or ignore) used both by the adapters (drop before send) and by
//     /v1/models `supported_parameters` (advertise per model).
//
// Forward-by-default: most OpenAI-compatible providers ignore unknown body
// fields, so the default is to send everything and let the per-platform
// droplist name the documented exceptions (Mistral 422s on unknown keys,
// Groq 400s on the logprobs family, Azure-backed GitHub Models rejects
// non-Azure knobs). A provider that still 400s fails over like any other
// provider-invalid request and shows up in the attempt trail — and its
// droplist entry is one line to add.

import { z } from 'zod';
import type { Platform } from '@freellmapi/shared/types.js';
import { getSetting } from '../db/index.js';

// OpenAI's request-side reasoning knob. Wire values as of the current OpenAI
// API: 'minimal'|'low'|'medium'|'high', plus 'none' (gpt-5.1). Forwarded
// verbatim to openai-compat platforms per the policy below; the Google
// adapter maps it natively onto generationConfig.thinkingConfig.
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

// Effort spellings clients actually send that aren't on OpenAI's scale, mapped
// to the nearest value we do support (#619: a strict enum turned a client's
// `reasoning_effort: 'max'` into a 400 from our own edge — a knob nobody asked
// to be fatal). Values that mean "let the model decide" ('auto', 'adaptive',
// 'default') are deliberately absent: they resolve to undefined below, i.e.
// nothing is forwarded and the provider default stands — same rule
// effortFromGeminiThinking applies to a -1 thinking budget.
const EFFORT_ALIASES: Readonly<Record<string, ReasoningEffort>> = {
  max: 'high', maximum: 'high', highest: 'high', ultra: 'high', xhigh: 'high', 'x-high': 'high',
  mid: 'medium', moderate: 'medium', balanced: 'medium', normal: 'medium', standard: 'medium',
  min: 'minimal', minimum: 'minimal', lowest: 'minimal', xlow: 'minimal', 'x-low': 'minimal',
  off: 'none', disabled: 'none', disable: 'none',
};

/**
 * Coerce a client-supplied effort value onto our scale: supported values pass
 * through, known aliases clamp to the nearest supported one, and anything
 * else (unknown word, wrong type, "auto") yields undefined — the knob is
 * dropped and the provider's own default applies. Never throws, so a bad
 * effort can't fail a request. Exported for tests.
 */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  if ((REASONING_EFFORTS as readonly string[]).includes(key)) return key as ReasoningEffort;
  return EFFORT_ALIASES[key];
}

/**
 * Clamp an effort to the nearest value a platform actually accepts, walking
 * the ordered scale outward from the requested one (ties go to the stronger
 * value, so 'medium' on a low/high platform becomes 'high'). Returns
 * undefined only when the platform accepts nothing.
 */
function clampEffortTo(effort: ReasoningEffort, supported: readonly ReasoningEffort[]): ReasoningEffort | undefined {
  if (supported.includes(effort)) return effort;
  const want = REASONING_EFFORTS.indexOf(effort);
  let best: ReasoningEffort | undefined;
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const distance = Math.abs(REASONING_EFFORTS.indexOf(candidate) - want);
    if (distance < bestDistance
        || (distance === bestDistance && best !== undefined
            && REASONING_EFFORTS.indexOf(candidate) > REASONING_EFFORTS.indexOf(best))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// Every field is `.nullable()` because real clients serialize their whole
// request struct and send explicit nulls for unset knobs (#200); null is
// treated as absent and never forwarded.
export const samplingParamSchemaFields = {
  top_k: z.number().int().min(1).nullable().optional(),
  min_p: z.number().min(0).max(1).nullable().optional(),
  seed: z.number().int().nullable().optional(),
  presence_penalty: z.number().min(-2).max(2).nullable().optional(),
  frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
  repetition_penalty: z.number().positive().nullable().optional(),
  logit_bias: z.record(z.string(), z.number()).nullable().optional(),
  logprobs: z.boolean().nullable().optional(),
  top_logprobs: z.number().int().min(0).max(20).nullable().optional(),
  response_format: z.object({
    type: z.enum(['text', 'json_object', 'json_schema']),
    json_schema: z.object({
      name: z.string().optional(),
      strict: z.boolean().nullable().optional(),
      schema: z.record(z.string(), z.unknown()).optional(),
    }).passthrough().optional(),
  }).passthrough().nullable().optional(),
  // Accepted as free-form and normalized by pickSamplingParams rather than
  // validated against the enum: clients invent effort values ('max', 'xhigh')
  // and rejecting them made an advisory knob fatal (#619).
  reasoning_effort: z.unknown().optional(),
  // Object-form alias some clients send (OpenRouter-style chat clients, and
  // the Responses API's native shape): `reasoning: { effort }`. Resolved into
  // reasoning_effort by pickSamplingParams; the wrapper object itself is never
  // forwarded. Extra keys (summary, max_tokens…) are tolerated and ignored.
  reasoning: z.object({
    effort: z.unknown().optional(),
  }).passthrough().nullable().optional(),
  // OpenAI's newer alias for max_tokens; surfaces resolve it into max_tokens
  // themselves (it is not a forwarded param of its own).
  max_completion_tokens: z.number().int().nullable().optional(),
} as const;

export interface ResponseFormat {
  type: 'json_object' | 'json_schema';
  json_schema?: {
    name?: string;
    strict?: boolean | null;
    schema?: Record<string, unknown>;
  } & Record<string, unknown>;
}

export interface ExtendedSamplingOptions {
  top_k?: number;
  min_p?: number;
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  repetition_penalty?: number;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  response_format?: ResponseFormat;
  reasoning_effort?: ReasoningEffort;
}

export const EXTENDED_SAMPLING_KEYS = [
  'top_k', 'min_p', 'seed', 'presence_penalty', 'frequency_penalty',
  'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs',
  'response_format', 'reasoning_effort',
] as const;
export type ExtendedSamplingKey = typeof EXTENDED_SAMPLING_KEYS[number];

type ParsedSamplingBody = {
  [K in ExtendedSamplingKey]?: unknown;
} & {
  // Object-form reasoning alias (see samplingParamSchemaFields); resolved into
  // reasoning_effort below, never forwarded as-is.
  reasoning?: { effort?: unknown } | null;
};

/**
 * Turn a schema-parsed request body into the extended CompletionOptions
 * fields: nulls dropped, `response_format: {type:'text'}` dropped (it is the
 * default and some providers 400 on receiving it explicitly), everything else
 * forwarded as-is.
 */
export function pickSamplingParams(body: ParsedSamplingBody): ExtendedSamplingOptions {
  const out: Record<string, unknown> = {};
  for (const key of EXTENDED_SAMPLING_KEYS) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (key === 'response_format' && (value as { type?: string }).type === 'text') continue;
    if (key === 'reasoning_effort') {
      const effort = normalizeReasoningEffort(value);
      if (effort === undefined) continue;
      out[key] = effort;
      continue;
    }
    out[key] = value;
  }
  // Object-form fallback: `reasoning: { effort }` fills reasoning_effort only
  // when the flat field wasn't sent (the explicit flat form wins on conflict).
  if (out.reasoning_effort === undefined) {
    const effort = normalizeReasoningEffort(body.reasoning?.effort);
    if (effort !== undefined) out.reasoning_effort = effort;
  }
  return out as ExtendedSamplingOptions;
}

// ── Per-platform support policy ──────────────────────────────────────────────
// `drop` = params this platform is KNOWN to reject (or that would corrupt the
// request); stripped by the adapter before send and omitted from the model's
// advertised `supported_parameters`. `rename` = same param, different wire
// name. Platforms not listed forward everything.
//
// Deliberately conservative: only documented/observed rejections are listed,
// because wrongly dropping a working param is as bad as a 400. Findings from
// live sweeps go here, one line each.
export interface PlatformParamPolicy {
  drop?: readonly ExtendedSamplingKey[];
  rename?: Readonly<Partial<Record<ExtendedSamplingKey, string>>>;
  // The platform supports json_schema but 400s on json_object (observed live:
  // Reka — "Unsupported response_format type: 'json_object'. Supported types
  // are 'text' and 'json_schema'."). Upgrade json_object to a permissive
  // json_schema on the wire instead of dropping structured output entirely.
  jsonObjectToSchema?: boolean;
  // The effort values this platform's API accepts, when it accepts fewer than
  // the full scale. A request outside the set is clamped to the nearest
  // supported value instead of being forwarded into a 400 (#619). Omitted =
  // forward whatever the client asked for.
  reasoningEfforts?: readonly ReasoningEffort[];
  // Output-token floor sent when — and ONLY when — the client omitted
  // max_tokens entirely (#553). Some providers apply a tiny server-side
  // default in that case and cut the answer off mid-sentence, which clients
  // experience as a broken stream rather than as a truncation. A
  // client-supplied value always wins, larger or smaller. Applied by the
  // adapters through resolveMaxTokens(), so a platform added here only takes
  // effect once its adapter routes max_tokens through that helper (they all
  // do).
  defaultMaxTokens?: number;
  // Output-token CEILING this platform's API enforces itself, applied by
  // resolveMaxTokens() whatever the client asked for. The mirror image of
  // defaultMaxTokens: a floor rescues a client that sent nothing, a cap
  // rescues one that sent too much. Without it an aggressive max_tokens
  // (Open WebUI's 65536 default) is a guaranteed 400 on every hop that lands
  // on such a platform, and the fallback chain cannot repair it because the
  // same value rides every candidate. Effective max_tokens is min(requested,
  // this cap, the operator's unified cap).
  maxTokensCap?: number;
}

/** GitHub Models' own output-token ceiling: asking for more 400s ("max_tokens
 *  is too large"), so the request never reaches the model. Wired into the
 *  github policy below as maxTokensCap. */
export const GITHUB_MAX_OUTPUT_TOKENS = 400;

// Keyed by Platform (not string) so a typo'd platform id fails tsc instead of
// silently no-op'ing the policy; the string-typed accessors below cast at the
// boundary since routes carry platform ids as plain strings.
export const PLATFORM_PARAM_POLICIES: Partial<Record<Platform, PlatformParamPolicy>> = {
  // Mistral's API is strict (422 on unknown body keys) and names its seed
  // `random_seed`. It has no top_k/min_p/logit_bias/logprobs equivalents, and
  // no reasoning_effort (Magistral's reasoning has no request-side knob).
  mistral: {
    drop: ['top_k', 'min_p', 'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'reasoning_effort'],
    rename: { seed: 'random_seed' },
  },
  // Groq documents logprobs / top_logprobs / logit_bias as unsupported and
  // rejects requests that include them.
  groq: { drop: ['logprobs', 'top_logprobs', 'logit_bias'] },
  // GitHub Models sits on Azure OpenAI, which 400s "Unrecognized request
  // argument" for knobs outside the OpenAI set. Its reasoning_effort enum is
  // the older low/medium/high one, so 'none'/'minimal' are clamped rather
  // than sent. Its free tier also refuses any max_tokens above
  // GITHUB_MAX_OUTPUT_TOKENS, so the cap is clamped here instead of being
  // spent as a wasted fallback hop.
  github: {
    drop: ['top_k', 'min_p', 'repetition_penalty'],
    reasoningEfforts: ['low', 'medium', 'high'],
    maxTokensCap: GITHUB_MAX_OUTPUT_TOKENS,
  },
  // Gemini's generationConfig has no equivalents for these; the adapter
  // translates the rest natively (topK, seed, penalties, responseSchema, and
  // reasoning_effort → thinkingConfig — see toGeminiExtendedConfig).
  google: { drop: ['min_p', 'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs'] },
  // Cohere's OpenAI-compat endpoint covers seed/penalties/response_format;
  // the rest (incl. reasoning_effort — Cohere's own knob is a non-OpenAI
  // `thinking` object) have no mapping there.
  cohere: { drop: ['top_k', 'min_p', 'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'reasoning_effort'] },
  // Workers AI's OpenAI-compat endpoint parses a known subset; send only what
  // it understands. It also applies a small server-side max_tokens default
  // when the request omits one, so an SDK client that never sets max_tokens
  // (the common case) sees answers stop a couple of seconds in — reported on
  // @cf/openai/gpt-oss-120b, where the model's own reasoning trace eats the
  // default before any visible text lands (#553). 8192 is the floor we send
  // instead: generous for a chat turn plus reasoning, and small enough to fit
  // inside the smallest context window in the Workers AI catalog (24K on
  // @cf/meta/llama-3.3-70b-instruct-fp8-fast) with room left for the prompt.
  cloudflare: {
    drop: ['min_p', 'logit_bias', 'logprobs', 'top_logprobs', 'reasoning_effort'],
    defaultMaxTokens: 8192,
  },
  // AI Horde builds its own payload format; none of the extended set maps.
  aihorde: { drop: [...EXTENDED_SAMPLING_KEYS] },
  // Kilo's anonymous gateway 400s ("Provider returned error") whenever
  // response_format is present — observed live 2026-07-11; seed passes fine.
  // Dropping it also makes structured-output routing skip kilo entirely.
  kilo: { drop: ['response_format'] },
  // Reka supports json_schema but rejects json_object (live 2026-07-11);
  // upgraded on the wire instead of dropped.
  reka: { jsonObjectToSchema: true },
};

// The permissive schema a json_object request is upgraded to on platforms
// that only accept json_schema (any JSON object satisfies it). The empty
// `properties` map matters: Reka 503s on a bare {type:'object'} but accepts
// this shape (probed live 2026-07-11); additionalProperties keeps arbitrary
// keys legal.
const ANY_OBJECT_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: { name: 'json_output', schema: { type: 'object', properties: {}, additionalProperties: true } },
};

/**
 * Build the extended wire-body fields for one platform: policy droplist
 * applied, renames applied, undefined skipped. Adapters spread the result
 * into their OpenAI-shaped request bodies.
 */
export function extendedBodyParams(platform: string, options: ExtendedSamplingOptions | undefined): Record<string, unknown> {
  if (!options) return {};
  const policy = PLATFORM_PARAM_POLICIES[platform as Platform];
  const dropped = new Set<string>(policy?.drop ?? []);
  const out: Record<string, unknown> = {};
  for (const key of EXTENDED_SAMPLING_KEYS) {
    if (dropped.has(key)) continue;
    let value = (options as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'response_format' && policy?.jsonObjectToSchema
        && (value as { type?: string }).type === 'json_object') {
      value = ANY_OBJECT_SCHEMA;
    }
    if (key === 'reasoning_effort' && policy?.reasoningEfforts) {
      value = clampEffortTo(value as ReasoningEffort, policy.reasoningEfforts);
      if (value === undefined) continue;
    }
    out[policy?.rename?.[key] ?? key] = value;
  }
  return out;
}

/** The output-token floor this platform sends for a request that carries no
 *  max_tokens at all, or undefined when the provider's own default is fine. */
export function defaultMaxTokensFor(platform: string): number | undefined {
  return PLATFORM_PARAM_POLICIES[platform as Platform]?.defaultMaxTokens;
}

/** This platform's own output-token ceiling, or undefined when it accepts
 *  whatever max_tokens the client asks for. */
export function maxTokensCapFor(platform: string): number | undefined {
  return PLATFORM_PARAM_POLICIES[platform as Platform]?.maxTokensCap;
}

/**
 * The max_tokens to put on the wire for one request: whatever the client asked
 * for, or the platform's floor when the client asked for nothing (#553), then
 * lowered to the tightest ceiling that applies — the platform's own
 * maxTokensCap, the operator's unified cap, or both. With neither in play
 * nothing is clamped — a client-set value passes through untouched in both
 * directions, and the gateway's own guardrails (token budget, routing reserve)
 * have already had their say by the time an adapter calls this.
 *
 * EVERY adapter must send max_tokens through here, or the cap is not unified:
 * openai-compat (and its subclasses), cloudflare, cohere, google and aihorde
 * all do.
 */
export function resolveMaxTokens(platform: string, requested: number | undefined): number | undefined {
  const resolved = requested ?? defaultMaxTokensFor(platform);
  if (resolved == null) return resolved;
  // The tighter ceiling wins: a platform's hard reject applies even with the
  // operator cap off, and an operator cap below it applies everywhere.
  const caps = [unifiedMaxTokensCap(), maxTokensCapFor(platform)].filter((c): c is number => c != null);
  return caps.length === 0 ? resolved : Math.min(resolved, ...caps);
}

// ── Unified output-token cap ─────────────────────────────────────────────────
// Optional operator-level ceiling on max_tokens for EVERY client. Aggressive
// clients (Open WebUI sends max_tokens=65536 by default) 400 against free
// models whose output limit is 32768 (CF qwen3-30b, zhipu glm), and without a
// ceiling the same invalid value rides every fallback candidate — the chain
// cannot rescue the request. The cap only LOWERS an
// excessive value; a client value at or below it is untouched, and clients that
// send nothing still get today's platform floor. 'off' (default) keeps the
// historical pass-through behaviour.
export const UNIFIED_MAX_TOKENS_SETTING = 'unified_max_tokens';
/** The ceiling 'auto' clamps to: the output limit of the largest common free
 *  catalog models. */
export const UNIFIED_MAX_TOKENS_AUTO = 32768;

/** The configured unified output cap, or null when disabled ('off'/unset).
 *  'auto' resolves to UNIFIED_MAX_TOKENS_AUTO; an explicit integer is used
 *  verbatim; anything else is treated as disabled so a bad value can't 400
 *  requests. Reads the settings table on every call — cheap (better-sqlite3
 *  sync read) and picks up dashboard changes without a restart, mirroring
 *  guardrails.ts. */
export function unifiedMaxTokensCap(): number | null {
  let raw: string | undefined;
  try {
    raw = getSetting(UNIFIED_MAX_TOKENS_SETTING);
  } catch {
    return null; // DB not ready — never throw on the proxy hot path
  }
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'off' || value === '0') return null;
  if (value === 'auto') return UNIFIED_MAX_TOKENS_AUTO;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** True when this platform's policy strips response_format before send — the
 *  router uses it to skip such platforms for structured-output requests. */
export function platformDropsResponseFormat(platform: string): boolean {
  return PLATFORM_PARAM_POLICIES[platform as Platform]?.drop?.includes('response_format') ?? false;
}

/** The advertised parameter list for a model on `platform` — the base set
 *  every surface supports, plus tools when the model does, minus the
 *  platform's droplist. */
export function supportedParametersFor(platform: string, caps: { tools?: boolean } = {}): string[] {
  const policy = PLATFORM_PARAM_POLICIES[platform as Platform];
  const dropped = new Set<string>(policy?.drop ?? []);
  const params = [
    'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'stream',
    ...EXTENDED_SAMPLING_KEYS.filter(k => !dropped.has(k)),
  ];
  if (caps.tools) params.push('tools', 'tool_choice', 'parallel_tool_calls');
  return params;
}

/** For a model served by several platforms (a unify group): the INTERSECTION
 *  of the members' supported sets — a param is only advertised when every
 *  platform the router might pick honors it. */
export function supportedParametersForPlatforms(platforms: string[], caps: { tools?: boolean } = {}): string[] {
  if (platforms.length === 0) return supportedParametersFor('', caps);
  const [first, ...rest] = platforms.map(p => supportedParametersFor(p, caps));
  const restSets = rest.map(list => new Set(list));
  return first.filter(param => restSets.every(s => s.has(param)));
}
