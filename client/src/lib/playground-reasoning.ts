// The Playground's reasoning controls: per-model reasoning effort and optional
// thinking budget, as the settings rail edits them and as /v1/chat/completions
// receives them.
//
// Capabilities are detected from the server's /api/fallback metadata (derived
// from server/src/lib/sampling-params.ts). Supported models default to
// 'medium' when supported, while unsupported models emit no reasoning fields
// so their provider defaults are preserved without breaking compatibility.
//
// Pure on purpose (bar the two localStorage wrappers at the bottom), mirroring
// playground-sampling.ts. No `@/` alias here so unit tests run under the
// standalone vitest config.

/** localStorage key holding per-model Playground reasoning preferences. */
export const REASONING_KEY = 'playground.reasoning'

export const ALL_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'max'] as const
export type ReasoningEffortLevel = typeof ALL_REASONING_EFFORTS[number]

export interface ReasoningCapabilities {
  supported: boolean
  efforts: ReasoningEffortLevel[]
  supportsThinkingBudget: boolean
}

export interface ReasoningModelEntry {
  modelId: string
  canonicalId?: string
  reasoningCapabilities?: ReasoningCapabilities
}

export interface ModelReasoningPreference {
  effort: ReasoningEffortLevel
  thinkingBudgetEnabled: boolean
  thinkingBudget: number
}

export type ReasoningPreferencesMap = Record<string, ModelReasoningPreference>

export interface ReasoningRequestParams {
  reasoning_effort?: ReasoningEffortLevel
  thinking_budget?: number
}

export const THINKING_BUDGET_RANGE = {
  min: 0,
  max: 1_000_000,
  step: 1,
} as const

export const DEFAULT_THINKING_BUDGET = 8192

export const DEFAULT_MODEL_REASONING_PREF: ModelReasoningPreference = {
  effort: 'medium',
  thinkingBudgetEnabled: false,
  thinkingBudget: DEFAULT_THINKING_BUDGET,
}

export const UNSUPPORTED_REASONING: ReasoningCapabilities = {
  supported: false,
  efforts: [],
  supportsThinkingBudget: false,
}

function isReasoningEffort(value: unknown): value is ReasoningEffortLevel {
  return typeof value === 'string' && (ALL_REASONING_EFFORTS as readonly string[]).includes(value)
}

/** Clamp a thinking budget to a non-negative integer within the proxy's bounds. */
export function clampThinkingBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THINKING_BUDGET
  return Math.min(THINKING_BUDGET_RANGE.max, Math.max(THINKING_BUDGET_RANGE.min, Math.round(value)))
}

/**
 * Clamp an effort to the nearest value a model/provider supports, walking the
 * ordered scale outward from the requested level (ties favor the stronger one).
 */
export function clampEffortToSupported(
  effort: ReasoningEffortLevel,
  supported: readonly ReasoningEffortLevel[],
): ReasoningEffortLevel | null {
  if (supported.length === 0) return null
  if (supported.includes(effort)) return effort
  const want = ALL_REASONING_EFFORTS.indexOf(effort)
  let best: ReasoningEffortLevel | null = null
  let bestDistance = Infinity
  for (const candidate of supported) {
    const idx = ALL_REASONING_EFFORTS.indexOf(candidate)
    const distance = Math.abs(idx - want)
    if (
      distance < bestDistance
      || (distance === bestDistance && best !== null && idx > ALL_REASONING_EFFORTS.indexOf(best))
    ) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** Merge reasoning capabilities across multiple provider rows for one model or pool. */
export function mergeReasoningCapabilities(
  list: ReadonlyArray<ReasoningCapabilities | undefined>,
): ReasoningCapabilities {
  const supported = list.some(c => c?.supported === true && c.efforts.length > 0)
  if (!supported) return UNSUPPORTED_REASONING
  const efforts = ALL_REASONING_EFFORTS.filter(e =>
    list.some(c => c?.supported === true && c.efforts.includes(e)),
  )
  const supportsThinkingBudget = list.some(c => c?.supported === true && c.supportsThinkingBudget === true)
  return {
    supported: efforts.length > 0,
    efforts,
    supportsThinkingBudget,
  }
}

/**
 * Detect the reasoning capabilities for the currently selected Playground model.
 * Auto / Fusion / custom chains aggregate across all available models; pinned
 * models aggregate across the providers serving that model.
 */
export function resolveReasoningCapabilities(
  selectedModel: string,
  availableModels: ReadonlyArray<ReasoningModelEntry>,
): ReasoningCapabilities {
  if (availableModels.length === 0) return UNSUPPORTED_REASONING
  if (selectedModel === 'auto' || selectedModel === 'fusion' || selectedModel.startsWith('auto:')) {
    return mergeReasoningCapabilities(availableModels.map(m => m.reasoningCapabilities))
  }
  const matches = availableModels.filter(
    m => (m.canonicalId ?? m.modelId) === selectedModel || m.modelId === selectedModel,
  )
  return mergeReasoningCapabilities(matches.map(m => m.reasoningCapabilities))
}

/** Default effort for a supported model: Medium when supported, else nearest. */
export function defaultEffortFor(caps: ReasoningCapabilities): ReasoningEffortLevel | null {
  if (!caps.supported || caps.efforts.length === 0) return null
  return clampEffortToSupported('medium', caps.efforts)
}

/** Resolve the effective reasoning effort for a model given saved preferences. */
export function resolveEffortForModel(
  prefs: ReasoningPreferencesMap,
  modelKey: string,
  caps: ReasoningCapabilities,
): ReasoningEffortLevel | null {
  if (!caps.supported || caps.efforts.length === 0) return null
  const saved = prefs[modelKey]?.effort
  if (saved) return clampEffortToSupported(saved, caps.efforts)
  return defaultEffortFor(caps)
}

/** Resolve the thinking budget UI state for a model given saved preferences. */
export function resolveThinkingBudgetForModel(
  prefs: ReasoningPreferencesMap,
  modelKey: string,
): { enabled: boolean; value: number } {
  const saved = prefs[modelKey]
  if (!saved) return { enabled: false, value: DEFAULT_THINKING_BUDGET }
  return {
    enabled: saved.thinkingBudgetEnabled === true,
    value: clampThinkingBudget(saved.thinkingBudget),
  }
}

/** Copy with one model's reasoning effort updated; never mutates the input. */
export function setModelReasoningEffort(
  prefs: ReasoningPreferencesMap,
  modelKey: string,
  effort: ReasoningEffortLevel,
): ReasoningPreferencesMap {
  const current = prefs[modelKey] ?? DEFAULT_MODEL_REASONING_PREF
  return {
    ...prefs,
    [modelKey]: {
      ...current,
      effort,
    },
  }
}

/** Copy with one model's thinking budget toggle updated; keeps the dialled-in value. */
export function setModelThinkingBudgetEnabled(
  prefs: ReasoningPreferencesMap,
  modelKey: string,
  enabled: boolean,
): ReasoningPreferencesMap {
  const current = prefs[modelKey] ?? DEFAULT_MODEL_REASONING_PREF
  return {
    ...prefs,
    [modelKey]: {
      ...current,
      thinkingBudgetEnabled: enabled,
    },
  }
}

/** Copy with one model's thinking budget value updated (clamped). */
export function setModelThinkingBudget(
  prefs: ReasoningPreferencesMap,
  modelKey: string,
  budget: number,
): ReasoningPreferencesMap {
  const current = prefs[modelKey] ?? DEFAULT_MODEL_REASONING_PREF
  return {
    ...prefs,
    [modelKey]: {
      ...current,
      thinkingBudget: clampThinkingBudget(budget),
    },
  }
}

/**
 * Build the reasoning request fragment for /v1/chat/completions.
 * Unsupported models emit nothing so provider defaults remain intact.
 */
export function reasoningRequestParams(
  prefs: ReasoningPreferencesMap,
  modelKey: string,
  caps: ReasoningCapabilities,
): ReasoningRequestParams {
  if (!caps.supported) return {}
  const effort = resolveEffortForModel(prefs, modelKey, caps)
  if (!effort) return {}
  const params: ReasoningRequestParams = { reasoning_effort: effort }
  const budget = resolveThinkingBudgetForModel(prefs, modelKey)
  if (caps.supportsThinkingBudget && effort !== 'none' && budget.enabled) {
    params.thinking_budget = budget.value
  }
  return params
}

/** True when the user has customized reasoning settings away from defaults for this model. */
export function isReasoningCustomized(
  prefs: ReasoningPreferencesMap,
  modelKey: string,
  caps: ReasoningCapabilities,
): boolean {
  if (!caps.supported) return false
  const effort = resolveEffortForModel(prefs, modelKey, caps)
  const def = defaultEffortFor(caps)
  if (effort !== def) return true
  const budget = resolveThinkingBudgetForModel(prefs, modelKey)
  return caps.supportsThinkingBudget && effort !== 'none' && budget.enabled
}

function parseEntry(raw: unknown): ModelReasoningPreference | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as { effort?: unknown; thinkingBudgetEnabled?: unknown; thinkingBudget?: unknown }
  const effort = isReasoningEffort(record.effort) ? record.effort : DEFAULT_MODEL_REASONING_PREF.effort
  const thinkingBudgetEnabled = record.thinkingBudgetEnabled === true
  const thinkingBudget = typeof record.thinkingBudget === 'number'
    ? clampThinkingBudget(record.thinkingBudget)
    : DEFAULT_THINKING_BUDGET
  return { effort, thinkingBudgetEnabled, thinkingBudget }
}

/** Force every per-model entry back into shape and range. */
export function normalizeReasoningPreferences(source: unknown): ReasoningPreferencesMap {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const out: ReasoningPreferencesMap = {}
  for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
    if (!key) continue
    const parsed = parseEntry(raw)
    if (parsed) out[key] = parsed
  }
  return out
}

export function parseReasoningPreferences(raw: string | null | undefined): ReasoningPreferencesMap {
  if (!raw) return {}
  try {
    return normalizeReasoningPreferences(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function serializeReasoningPreferences(prefs: ReasoningPreferencesMap): string {
  return JSON.stringify(normalizeReasoningPreferences(prefs))
}

export function readReasoningPreferences(): ReasoningPreferencesMap {
  try {
    return parseReasoningPreferences(localStorage.getItem(REASONING_KEY))
  } catch {
    return {}
  }
}

export function writeReasoningPreferences(prefs: ReasoningPreferencesMap): void {
  try {
    localStorage.setItem(REASONING_KEY, serializeReasoningPreferences(prefs))
  } catch {
    // Private-mode / disabled storage: ignore write errors.
  }
}
