import { describe, it, expect } from 'vitest'
import { modelMakerOf } from './model-maker'

const id = (m: string) => modelMakerOf(m)?.id ?? null

describe('modelMakerOf', () => {
  it('reads the family out of bare ids, with or without separators before digits', () => {
    expect(id('gemini-3.1-flash-lite')).toBe('google')
    expect(id('gemma2-9b-it')).toBe('google')
    expect(id('llama3-8b-8192')).toBe('meta')
    expect(id('qwen3-235b-a22b')).toBe('qwen')
    expect(id('QwQ-32B')).toBe('qwen')
    expect(id('deepseek-r1-distill-llama-70b')).toBe('deepseek')
    expect(id('codestral-latest')).toBe('mistral')
    expect(id('claude-sonnet-4-5')).toBe('anthropic')
    expect(id('gpt-4o-mini')).toBe('openai')
    expect(id('gpt-oss-120b')).toBe('openai')
    expect(id('o3-mini')).toBe('openai')
    expect(id('nemotron-3-ultra-550b')).toBe('nvidia')
    expect(id('kimi-k2.6')).toBe('moonshot')
    expect(id('glm-4.7-flash')).toBe('zhipu')
    expect(id('command-a-03-2025')).toBe('cohere')
    expect(id('phi-4-mini')).toBe('microsoft')
    expect(id('grok-4-fast')).toBe('xai')
    expect(id('sonar-pro')).toBe('perplexity')
    expect(id('granite-4.0-h-micro')).toBe('ibm')
  })

  it('uses the org segment of a namespaced id, and lets the family win over it when both are present', () => {
    expect(id('meta-llama/Llama-3.3-70B-Instruct')).toBe('meta')
    expect(id('Qwen/Qwen3-VL-235B-A22B-Instruct')).toBe('qwen')
    expect(id('moonshotai/Kimi-K3')).toBe('moonshot')
    expect(id('thinkingmachines/Inkling')).toBe('thinkingmachines')
    expect(id('zai-org/GLM-5.2')).toBe('zhipu')
    // A derived brand beats the base it names: a DeepSeek distillation of Llama
    // is DeepSeek's, a Nemotron built on Llama is NVIDIA's.
    expect(id('deepseek-ai/DeepSeek-R1-Distill-Qwen-32B')).toBe('deepseek')
    expect(id('nvidia/Llama-3.1-Nemotron-70B-Instruct')).toBe('nvidia')
    expect(id('openai/some-new-thing:free')).toBe('openai')
  })

  it('returns null for ids it cannot place, and for empty input', () => {
    expect(modelMakerOf('compound-mini')).toBeNull()
    expect(modelMakerOf('auto')).toBeNull()
    expect(modelMakerOf('')).toBeNull()
    expect(modelMakerOf(undefined)).toBeNull()
  })

  it('carries a display name', () => {
    expect(modelMakerOf('mistral-small-latest')).toEqual({ id: 'mistral', name: 'Mistral AI' })
  })
})
