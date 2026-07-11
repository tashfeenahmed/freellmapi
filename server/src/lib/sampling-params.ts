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
}

export const EXTENDED_SAMPLING_KEYS = [
  'top_k', 'min_p', 'seed', 'presence_penalty', 'frequency_penalty',
  'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs',
  'response_format',
] as const;
export type ExtendedSamplingKey = typeof EXTENDED_SAMPLING_KEYS[number];

type ParsedSamplingBody = {
  [K in ExtendedSamplingKey]?: unknown;
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
    out[key] = value;
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
}

export const PLATFORM_PARAM_POLICIES: Record<string, PlatformParamPolicy> = {
  // Mistral's API is strict (422 on unknown body keys) and names its seed
  // `random_seed`. It has no top_k/min_p/logit_bias/logprobs equivalents.
  mistral: {
    drop: ['top_k', 'min_p', 'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs'],
    rename: { seed: 'random_seed' },
  },
  // Groq documents logprobs / top_logprobs / logit_bias as unsupported and
  // rejects requests that include them.
  groq: { drop: ['logprobs', 'top_logprobs', 'logit_bias'] },
  // GitHub Models sits on Azure OpenAI, which 400s "Unrecognized request
  // argument" for knobs outside the OpenAI set.
  github: { drop: ['top_k', 'min_p', 'repetition_penalty'] },
  // Gemini's generationConfig has no equivalents for these; the adapter
  // translates the rest natively (topK, seed, penalties, responseSchema).
  google: { drop: ['min_p', 'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs'] },
  // Cohere's OpenAI-compat endpoint covers seed/penalties/response_format;
  // the rest have no mapping there.
  cohere: { drop: ['top_k', 'min_p', 'repetition_penalty', 'logit_bias', 'logprobs', 'top_logprobs'] },
  // Workers AI's OpenAI-compat endpoint parses a known subset; send only what
  // it understands.
  cloudflare: { drop: ['min_p', 'logit_bias', 'logprobs', 'top_logprobs'] },
  // AI Horde builds its own payload format; none of the extended set maps.
  aihorde: { drop: [...EXTENDED_SAMPLING_KEYS] },
};

/**
 * Build the extended wire-body fields for one platform: policy droplist
 * applied, renames applied, undefined skipped. Adapters spread the result
 * into their OpenAI-shaped request bodies.
 */
export function extendedBodyParams(platform: string, options: ExtendedSamplingOptions | undefined): Record<string, unknown> {
  if (!options) return {};
  const policy = PLATFORM_PARAM_POLICIES[platform];
  const dropped = new Set<string>(policy?.drop ?? []);
  const out: Record<string, unknown> = {};
  for (const key of EXTENDED_SAMPLING_KEYS) {
    if (dropped.has(key)) continue;
    const value = (options as Record<string, unknown>)[key];
    if (value === undefined) continue;
    out[policy?.rename?.[key] ?? key] = value;
  }
  return out;
}

/** True when this platform's policy strips response_format before send — the
 *  router uses it to skip such platforms for structured-output requests. */
export function platformDropsResponseFormat(platform: string): boolean {
  return PLATFORM_PARAM_POLICIES[platform]?.drop?.includes('response_format') ?? false;
}

/** The advertised parameter list for a model on `platform` — the base set
 *  every surface supports, plus tools when the model does, minus the
 *  platform's droplist. */
export function supportedParametersFor(platform: string, caps: { tools?: boolean } = {}): string[] {
  const policy = PLATFORM_PARAM_POLICIES[platform];
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
