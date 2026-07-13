import { describe, it, expect } from 'vitest'
import { parseModelList } from '@/lib/model-list'

// Smoke-level coverage for the model-selector parser used by the custom
// provider form. Boundary cases only — not exhaustive.
describe('parseModelList (model selector)', () => {
  it('splits on commas and newlines, trimming whitespace', () => {
    expect(parseModelList('qwen3:4b, llama3:8b\nmistral:7b')).toEqual([
      'qwen3:4b',
      'llama3:8b',
      'mistral:7b',
    ])
  })

  it('drops blank entries', () => {
    expect(parseModelList('a, ,\nb,\n')).toEqual(['a', 'b'])
  })

  it('dedupes identical ids', () => {
    expect(parseModelList('gpt-4o, gpt-4o, gpt-4o')).toEqual(['gpt-4o'])
  })

  it('returns an empty array for empty / whitespace input', () => {
    expect(parseModelList('')).toEqual([])
    expect(parseModelList('   \n  ')).toEqual([])
  })
})
