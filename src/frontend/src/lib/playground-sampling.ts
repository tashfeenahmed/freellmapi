// The Playground's sampling knobs: temperature, top_p and max_tokens, as the
// settings rail edits them and as /v1/chat/completions receives them.
//
// Every control is opt-in. Until you switch one on the request body carries no
// field for it at all and the provider's own default applies — "unset" and
// "set to something that happens to look like the default" are genuinely
// different requests, and 0 is a meaningful temperature, so the stored shape
// keeps an explicit `enabled` flag beside a remembered value rather than
// overloading null. Switching a control off therefore keeps the number you had
// dialled in, ready for the next time you switch it back on.
//
// Pure on purpose (bar the two localStorage wrappers at the bottom): clamping,
// (de)serialisation and the request fragment are all testable without a
// component, which is where the interesting edge cases live.
//
// No `@/` alias here: the unit tests run under the standalone vitest config,
// which does not carry the app's path aliases.

/** localStorage key holding the Playground's sampling settings. */
export const SAMPLING_KEY = 'playground.sampling'

export interface SamplingRange {
  min: number
  max: number
  step: number
}

/** One knob: whether it is sent at all, and the value it would be sent with. */
export interface SamplingControl {
  enabled: boolean
  value: number
}

export interface SamplingSettings {
  temperature: SamplingControl
  topP: SamplingControl
  maxTokens: SamplingControl
}

export type SamplingField = keyof SamplingSettings

/**
 * Bounds mirror the Zod schema on POST /v1/chat/completions (temperature
 * 0–2, top_p 0–1, max_tokens a positive integer). The server stays the
 * authority; these just keep the rail from composing a request it knows will
 * be refused. The max_tokens ceiling is a sanity bound for the number box, not
 * a provider limit.
 */
export const SAMPLING_RANGES: Record<SamplingField, SamplingRange> = {
  temperature: { min: 0, max: 2, step: 0.1 },
  topP: { min: 0, max: 1, step: 0.05 },
  maxTokens: { min: 1, max: 1_000_000, step: 1 },
}

/** The request field each control maps onto, in OpenAI's spelling. */
export const SAMPLING_REQUEST_FIELDS: Record<SamplingField, 'temperature' | 'top_p' | 'max_tokens'> = {
  temperature: 'temperature',
  topP: 'top_p',
  maxTokens: 'max_tokens',
}

/** Everything off, with the value each knob starts at once switched on. */
export const DEFAULT_SAMPLING: SamplingSettings = {
  temperature: { enabled: false, value: 1 },
  topP: { enabled: false, value: 1 },
  maxTokens: { enabled: false, value: 1024 },
}

/** Render order for the rail; also the order the request fields are assembled in. */
export const SAMPLING_FIELDS: SamplingField[] = ['temperature', 'topP', 'maxTokens']

/** The request fragment for a set of settings — only the enabled knobs. */
export interface SamplingRequestParams {
  temperature?: number
  top_p?: number
  max_tokens?: number
}

function decimalsFor(step: number): number {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/**
 * Bring a value inside its range and onto its step, then off the float noise
 * that 0.1-sized steps produce (0.30000000000000004 is not a temperature).
 */
export function clampSampling(field: SamplingField, value: number): number {
  const range = SAMPLING_RANGES[field]
  if (!Number.isFinite(value)) return DEFAULT_SAMPLING[field].value
  const bounded = Math.min(range.max, Math.max(range.min, value))
  const steps = Math.round((bounded - range.min) / range.step)
  const snapped = range.min + steps * range.step
  return Number(snapped.toFixed(decimalsFor(range.step)))
}

/** The value as the rail prints it next to the slider. */
export function formatSamplingValue(field: SamplingField, value: number): string {
  return clampSampling(field, value).toFixed(decimalsFor(SAMPLING_RANGES[field].step))
}

/** Copy with one knob's value replaced (clamped); never mutates the input. */
export function setSamplingValue(
  settings: SamplingSettings,
  field: SamplingField,
  value: number,
): SamplingSettings {
  return {
    ...settings,
    [field]: { ...settings[field], value: clampSampling(field, value) },
  }
}

/** Copy with one knob switched on/off; the dialled-in value is kept either way. */
export function setSamplingEnabled(
  settings: SamplingSettings,
  field: SamplingField,
  enabled: boolean,
): SamplingSettings {
  return {
    ...settings,
    [field]: { ...settings[field], enabled },
  }
}

function parseControl(raw: unknown, field: SamplingField): SamplingControl {
  const fallback = DEFAULT_SAMPLING[field]
  if (!raw || typeof raw !== 'object') return { ...fallback }
  const control = raw as { enabled?: unknown; value?: unknown }
  return {
    // Anything but a literal true reads as off: a half-written entry must not
    // start silently steering completions.
    enabled: control.enabled === true,
    value: typeof control.value === 'number'
      ? clampSampling(field, control.value)
      : fallback.value,
  }
}

/**
 * Read settings back out of storage. Total tolerance by design — a corrupt,
 * truncated or older entry costs you your knobs, never the Playground.
 */
export function parseSampling(raw: string | null | undefined): SamplingSettings {
  if (!raw) return normalizeSampling(null)
  try {
    return normalizeSampling(JSON.parse(raw))
  } catch {
    return normalizeSampling(null)
  }
}

/** Every field forced back into shape and range, whatever `source` really is. */
export function normalizeSampling(source: unknown): SamplingSettings {
  const record = source && typeof source === 'object'
    ? source as Record<string, unknown>
    : undefined
  return {
    temperature: parseControl(record?.temperature, 'temperature'),
    topP: parseControl(record?.topP, 'topP'),
    maxTokens: parseControl(record?.maxTokens, 'maxTokens'),
  }
}

export function serializeSampling(settings: SamplingSettings): string {
  return JSON.stringify(normalizeSampling(settings))
}

/**
 * The knobs to merge into a /v1/chat/completions body. Only enabled controls
 * appear, so an untouched rail sends exactly the request it sent before this
 * feature existed.
 */
export function samplingRequestParams(settings: SamplingSettings): SamplingRequestParams {
  const params: SamplingRequestParams = {}
  for (const field of SAMPLING_FIELDS) {
    const control = settings[field]
    if (!control.enabled) continue
    params[SAMPLING_REQUEST_FIELDS[field]] = clampSampling(field, control.value)
  }
  return params
}

/** True when at least one knob is being sent — the rail badges itself with it. */
export function samplingActiveCount(settings: SamplingSettings): number {
  return SAMPLING_FIELDS.filter(field => settings[field].enabled).length
}

export function readSampling(): SamplingSettings {
  try {
    return parseSampling(localStorage.getItem(SAMPLING_KEY))
  } catch {
    // Private-mode / disabled storage: run with the defaults rather than
    // taking the page down.
    return normalizeSampling(null)
  }
}

export function writeSampling(settings: SamplingSettings): void {
  try {
    localStorage.setItem(SAMPLING_KEY, serializeSampling(settings))
  } catch {
    // Nothing to do and nothing worth interrupting the user for.
  }
}
