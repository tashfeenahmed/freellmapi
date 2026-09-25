// Turns an analyser's frequency snapshot into bar heights for the dictation
// wave drawn inside the composer while the mic is live. Pure, so the shaping
// is tested without an AudioContext.

/** Bars across the field. Odd so one sits dead centre. */
export const WAVE_BAR_COUNT = 31

/**
 * `data` is a getByteFrequencyData buffer (0..255 per bin). The bins are
 * bucketed evenly into `bars`, each bucket's mean drives one bar, and the
 * result is scaled into [min, max] px. Speech energy lives in the low bins,
 * so the buckets are laid out from the centre outwards — the middle bars
 * carry the voice, the edges the hiss — which reads as a wave rather than a
 * left-heavy staircase.
 */
export function barHeights(data: ArrayLike<number>, bars: number = WAVE_BAR_COUNT, min = 3, max = 22): number[] {
  const n = data.length
  if (bars <= 0) return []
  if (n === 0) return Array.from({ length: bars }, () => min)
  // Only the lower half of the spectrum carries anything a microphone hears.
  const usable = Math.max(1, Math.floor(n / 2))
  const perBar = usable / bars
  const levels: number[] = []
  for (let b = 0; b < bars; b++) {
    const start = Math.floor(b * perBar)
    const end = Math.max(start + 1, Math.floor((b + 1) * perBar))
    let sum = 0
    for (let i = start; i < end && i < n; i++) sum += data[i]
    levels.push(sum / (end - start) / 255)
  }
  // Centre-out ordering: bucket 0 (lowest, loudest) in the middle, then
  // alternating right/left so energy falls off symmetrically.
  const ordered: number[] = new Array(bars).fill(0)
  const mid = Math.floor(bars / 2)
  for (let b = 0; b < bars; b++) {
    const step = Math.ceil(b / 2)
    const idx = b % 2 === 0 ? mid + step : mid - step
    ordered[idx] = levels[b]
  }
  return ordered.map(v => min + Math.min(1, Math.max(0, v)) * (max - min))
}
