import { describe, it, expect } from 'vitest'
import { barHeights, WAVE_BAR_COUNT } from './waveform'

describe('barHeights', () => {
  it('returns one height per bar, resting at the minimum on silence', () => {
    const h = barHeights(new Uint8Array(128).fill(0))
    expect(h).toHaveLength(WAVE_BAR_COUNT)
    expect(h.every(v => v === 3)).toBe(true)
  })

  it('hits the maximum on a saturated signal', () => {
    const h = barHeights(new Uint8Array(128).fill(255), 5, 2, 20)
    expect(h).toEqual([20, 20, 20, 20, 20])
  })

  it('puts the loudest (lowest) bins in the centre and falls off to the edges', () => {
    // Energy concentrated in the first bins, as a voice is.
    const data = new Uint8Array(128)
    for (let i = 0; i < 8; i++) data[i] = 255
    const h = barHeights(data, 7, 0, 10)
    const mid = 3
    expect(h[mid]).toBeGreaterThan(h[0])
    expect(h[mid]).toBeGreaterThan(h[6])
    expect(h[mid]).toBe(Math.max(...h))
  })

  it('handles empty input and odd sizes without gaps', () => {
    expect(barHeights([], 4, 1, 9)).toEqual([1, 1, 1, 1])
    const h = barHeights(new Uint8Array(10).fill(100), 6)
    expect(h).toHaveLength(6)
    expect(h.every(v => Number.isFinite(v) && v >= 3 && v <= 22)).toBe(true)
  })
})
