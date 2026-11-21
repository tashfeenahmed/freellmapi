import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THINKING_BUDGET,
  UNSUPPORTED_REASONING,
  clampEffortToSupported,
  clampThinkingBudget,
  defaultEffortFor,
  isReasoningCustomized,
  mergeReasoningCapabilities,
  parseReasoningPreferences,
  reasoningRequestParams,
  resolveEffortForModel,
  resolveReasoningCapabilities,
  serializeReasoningPreferences,
  setModelReasoningEffort,
  setModelThinkingBudget,
  setModelThinkingBudgetEnabled,
  type ReasoningCapabilities,
  type ReasoningModelEntry,
} from './playground-reasoning'

const GOOGLE_CAPS: ReasoningCapabilities = {
  supported: true,
  efforts: ['none', 'low', 'medium', 'high'],
  supportsThinkingBudget: true,
}

const GROQ_CAPS: ReasoningCapabilities = {
  supported: true,
  efforts: ['low', 'medium', 'high'],
  supportsThinkingBudget: false,
}

const SAIL_CAPS: ReasoningCapabilities = {
  supported: true,
  efforts: ['none', 'low', 'medium', 'high', 'max'],
  supportsThinkingBudget: false,
}

describe('mergeReasoningCapabilities & resolveReasoningCapabilities', () => {
  it('returns unsupported when no provider supports reasoning', () => {
    expect(mergeReasoningCapabilities([UNSUPPORTED_REASONING, undefined])).toEqual(UNSUPPORTED_REASONING)
  })

  it('merges capabilities across multiple providers for a unified model', () => {
    const merged = mergeReasoningCapabilities([UNSUPPORTED_REASONING, GROQ_CAPS, GOOGLE_CAPS])
    expect(merged).toEqual({
      supported: true,
      efforts: ['none', 'low', 'medium', 'high'],
      supportsThinkingBudget: true,
    })
  })

  it('detects capabilities for pinned models and auto/fusion', () => {
    const models: ReasoningModelEntry[] = [
      { modelId: 'mistral-large', reasoningCapabilities: UNSUPPORTED_REASONING },
      { modelId: 'gemini-2.5-flash', canonicalId: 'gemini-2.5-flash', reasoningCapabilities: GOOGLE_CAPS },
      { modelId: 'openai/gpt-oss-120b', canonicalId: 'gpt-oss-120b', reasoningCapabilities: SAIL_CAPS },
    ]
    expect(resolveReasoningCapabilities('mistral-large', models)).toEqual(UNSUPPORTED_REASONING)
    expect(resolveReasoningCapabilities('gemini-2.5-flash', models)).toEqual(GOOGLE_CAPS)
    expect(resolveReasoningCapabilities('gpt-oss-120b', models)).toEqual(SAIL_CAPS)
    expect(resolveReasoningCapabilities('auto', models)).toEqual({
      supported: true,
      efforts: ['none', 'low', 'medium', 'high', 'max'],
      supportsThinkingBudget: true,
    })
  })
})

describe('defaultEffortFor & clampEffortToSupported', () => {
  it('defaults to medium when supported, and null when unsupported', () => {
    expect(defaultEffortFor(GOOGLE_CAPS)).toBe('medium')
    expect(defaultEffortFor(GROQ_CAPS)).toBe('medium')
    expect(defaultEffortFor(UNSUPPORTED_REASONING)).toBeNull()
  })

  it('clamps unsupported effort values to the nearest supported level', () => {
    expect(clampEffortToSupported('none', ['low', 'medium', 'high'])).toBe('low')
    expect(clampEffortToSupported('max', ['low', 'medium', 'high'])).toBe('high')
    expect(clampEffortToSupported('medium', ['low', 'high'])).toBe('high')
  })
})

describe('per-model preferences & reasoningRequestParams', () => {
  it('sends reasoning_effort: medium by default for supported models', () => {
    expect(reasoningRequestParams({}, 'gemini-2.5-flash', GOOGLE_CAPS)).toEqual({
      reasoning_effort: 'medium',
    })
    expect(isReasoningCustomized({}, 'gemini-2.5-flash', GOOGLE_CAPS)).toBe(false)
  })

  it('sends nothing for unsupported models so provider defaults remain intact', () => {
    const prefs = setModelReasoningEffort({}, 'mistral-large', 'high')
    expect(reasoningRequestParams(prefs, 'mistral-large', UNSUPPORTED_REASONING)).toEqual({})
    expect(isReasoningCustomized(prefs, 'mistral-large', UNSUPPORTED_REASONING)).toBe(false)
  })

  it('stores preferences independently per model', () => {
    let prefs = setModelReasoningEffort({}, 'gemini-2.5-flash', 'high')
    prefs = setModelReasoningEffort(prefs, 'gpt-oss-120b', 'max')
    expect(resolveEffortForModel(prefs, 'gemini-2.5-flash', GOOGLE_CAPS)).toBe('high')
    expect(resolveEffortForModel(prefs, 'gpt-oss-120b', SAIL_CAPS)).toBe('max')
    expect(resolveEffortForModel(prefs, 'other-model', GROQ_CAPS)).toBe('medium')
  })

  it('includes thinking_budget only when supported, enabled, and effort is not off', () => {
    let prefs = setModelThinkingBudgetEnabled({}, 'gemini-2.5-flash', true)
    prefs = setModelThinkingBudget(prefs, 'gemini-2.5-flash', 16384)
    expect(reasoningRequestParams(prefs, 'gemini-2.5-flash', GOOGLE_CAPS)).toEqual({
      reasoning_effort: 'medium',
      thinking_budget: 16384,
    })
    expect(isReasoningCustomized(prefs, 'gemini-2.5-flash', GOOGLE_CAPS)).toBe(true)

    // Disabling effort suppresses thinking_budget even if budget toggle was on.
    const turnedOff = setModelReasoningEffort(prefs, 'gemini-2.5-flash', 'none')
    expect(reasoningRequestParams(turnedOff, 'gemini-2.5-flash', GOOGLE_CAPS)).toEqual({
      reasoning_effort: 'none',
    })

    // Providers without thinking_budget never receive it.
    expect(reasoningRequestParams(prefs, 'gemini-2.5-flash', GROQ_CAPS)).toEqual({
      reasoning_effort: 'medium',
    })
  })
})

describe('clampThinkingBudget & storage round-trip', () => {
  it('clamps thinking budget to valid non-negative integers', () => {
    expect(clampThinkingBudget(-100)).toBe(0)
    expect(clampThinkingBudget(4096.6)).toBe(4097)
    expect(clampThinkingBudget(2_000_000)).toBe(1_000_000)
    expect(clampThinkingBudget(Number.NaN)).toBe(DEFAULT_THINKING_BUDGET)
  })

  it('round-trips through JSON and ignores corrupt storage', () => {
    let prefs = setModelReasoningEffort({}, 'gemini-2.5-flash', 'low')
    prefs = setModelThinkingBudgetEnabled(prefs, 'gemini-2.5-flash', true)
    prefs = setModelThinkingBudget(prefs, 'gemini-2.5-flash', 4096)
    expect(parseReasoningPreferences(serializeReasoningPreferences(prefs))).toEqual(prefs)
    expect(parseReasoningPreferences(null)).toEqual({})
    expect(parseReasoningPreferences('{bad json')).toEqual({})
    expect(parseReasoningPreferences('[]')).toEqual({})
  })
})
