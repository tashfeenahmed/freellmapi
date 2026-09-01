import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAMPLING,
  clampSampling,
  formatSamplingValue,
  normalizeSampling,
  parseSampling,
  samplingActiveCount,
  samplingRequestParams,
  serializeSampling,
  setSamplingEnabled,
  setSamplingValue,
  type SamplingSettings,
} from './playground-sampling'

const on = (settings: SamplingSettings, field: keyof SamplingSettings, value: number) =>
  setSamplingEnabled(setSamplingValue(settings, field, value), field, true)

describe('clampSampling', () => {
  it('holds each knob inside the range the proxy accepts', () => {
    expect(clampSampling('temperature', -1)).toBe(0)
    expect(clampSampling('temperature', 9)).toBe(2)
    expect(clampSampling('topP', -0.5)).toBe(0)
    expect(clampSampling('topP', 4)).toBe(1)
    expect(clampSampling('maxTokens', 0)).toBe(1)
    expect(clampSampling('maxTokens', -20)).toBe(1)
  })

  it('snaps to the step and keeps float noise out of the request', () => {
    expect(clampSampling('temperature', 0.30000000000000004)).toBe(0.3)
    expect(clampSampling('temperature', 0.74)).toBe(0.7)
    expect(clampSampling('temperature', 0.76)).toBe(0.8)
    expect(clampSampling('topP', 0.93)).toBe(0.95)
    expect(clampSampling('maxTokens', 1024.6)).toBe(1025)
  })

  it('falls back to the default for anything that is not a number', () => {
    expect(clampSampling('temperature', Number.NaN)).toBe(DEFAULT_SAMPLING.temperature.value)
    expect(clampSampling('topP', Number.POSITIVE_INFINITY)).toBe(DEFAULT_SAMPLING.topP.value)
    expect(clampSampling('maxTokens', Number.NaN)).toBe(DEFAULT_SAMPLING.maxTokens.value)
  })
})

describe('formatSamplingValue', () => {
  it('prints each knob at its own precision', () => {
    expect(formatSamplingValue('temperature', 0.7)).toBe('0.7')
    expect(formatSamplingValue('temperature', 2)).toBe('2.0')
    expect(formatSamplingValue('topP', 1)).toBe('1.00')
    expect(formatSamplingValue('topP', 0.05)).toBe('0.05')
    expect(formatSamplingValue('maxTokens', 512)).toBe('512')
  })
})

describe('setSamplingValue / setSamplingEnabled', () => {
  it('clamps on the way in and never mutates the input', () => {
    const next = setSamplingValue(DEFAULT_SAMPLING, 'temperature', 5)
    expect(next.temperature.value).toBe(2)
    expect(DEFAULT_SAMPLING.temperature.value).toBe(1)
    expect(next.topP).toEqual(DEFAULT_SAMPLING.topP)
  })

  it('keeps the dialled-in value when a knob is switched off', () => {
    const tuned = on(DEFAULT_SAMPLING, 'temperature', 0.2)
    const off = setSamplingEnabled(tuned, 'temperature', false)
    expect(off.temperature).toEqual({ enabled: false, value: 0.2 })
    expect(setSamplingEnabled(off, 'temperature', true).temperature.value).toBe(0.2)
  })
})

describe('samplingRequestParams', () => {
  it('sends nothing at all while every knob is off', () => {
    expect(samplingRequestParams(DEFAULT_SAMPLING)).toEqual({})
    expect(samplingActiveCount(DEFAULT_SAMPLING)).toBe(0)
  })

  it('sends only the enabled knobs, under their OpenAI names', () => {
    const settings = on(on(DEFAULT_SAMPLING, 'temperature', 0.3), 'maxTokens', 256)
    expect(samplingRequestParams(settings)).toEqual({ temperature: 0.3, max_tokens: 256 })
    expect(samplingActiveCount(settings)).toBe(2)
  })

  it('sends a deliberate zero — off and "0" are different requests', () => {
    const settings = on(DEFAULT_SAMPLING, 'temperature', 0)
    expect(samplingRequestParams(settings)).toEqual({ temperature: 0 })
    expect('temperature' in samplingRequestParams(settings)).toBe(true)
  })

  it('clamps a stored value that drifted out of range before sending it', () => {
    const settings: SamplingSettings = {
      ...DEFAULT_SAMPLING,
      topP: { enabled: true, value: 12 },
    }
    expect(samplingRequestParams(settings)).toEqual({ top_p: 1 })
  })

  it('maps all three knobs at once', () => {
    const settings = on(on(on(DEFAULT_SAMPLING, 'temperature', 1.5), 'topP', 0.9), 'maxTokens', 4096)
    expect(samplingRequestParams(settings)).toEqual({
      temperature: 1.5,
      top_p: 0.9,
      max_tokens: 4096,
    })
  })
})

describe('parseSampling', () => {
  it('reads back exactly what serializeSampling wrote', () => {
    const settings = on(on(DEFAULT_SAMPLING, 'topP', 0.85), 'maxTokens', 2048)
    expect(parseSampling(serializeSampling(settings))).toEqual(settings)
  })

  it('falls back to the defaults for a missing or unreadable entry', () => {
    expect(parseSampling(null)).toEqual(DEFAULT_SAMPLING)
    expect(parseSampling('')).toEqual(DEFAULT_SAMPLING)
    expect(parseSampling('{not json')).toEqual(DEFAULT_SAMPLING)
    expect(parseSampling('42')).toEqual(DEFAULT_SAMPLING)
    expect(parseSampling('null')).toEqual(DEFAULT_SAMPLING)
  })

  it('fills in the knobs a partial entry is missing', () => {
    expect(parseSampling('{"temperature":{"enabled":true,"value":0.4}}')).toEqual({
      temperature: { enabled: true, value: 0.4 },
      topP: DEFAULT_SAMPLING.topP,
      maxTokens: DEFAULT_SAMPLING.maxTokens,
    })
  })

  it('treats anything but a literal true as off', () => {
    const parsed = parseSampling('{"temperature":{"enabled":"yes","value":0.4}}')
    expect(parsed.temperature).toEqual({ enabled: false, value: 0.4 })
    expect(samplingRequestParams(parsed)).toEqual({})
  })

  it('repairs values that are the wrong type or out of range', () => {
    const parsed = parseSampling(
      '{"temperature":{"enabled":true,"value":"hot"},"topP":{"enabled":true,"value":7},"maxTokens":{"enabled":true,"value":-3}}',
    )
    expect(parsed.temperature.value).toBe(DEFAULT_SAMPLING.temperature.value)
    expect(parsed.topP.value).toBe(1)
    expect(parsed.maxTokens.value).toBe(1)
  })
})

describe('normalizeSampling', () => {
  it('accepts any shape and always returns all three knobs', () => {
    expect(normalizeSampling(undefined)).toEqual(DEFAULT_SAMPLING)
    expect(normalizeSampling('nonsense')).toEqual(DEFAULT_SAMPLING)
    expect(normalizeSampling({ temperature: 3 })).toEqual(DEFAULT_SAMPLING)
  })
})
