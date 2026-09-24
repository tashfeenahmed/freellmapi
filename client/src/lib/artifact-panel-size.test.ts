import { describe, it, expect } from 'vitest'
import {
  ARTIFACT_MIN_WIDTH,
  CHAT_MIN_WIDTH,
  clampArtifactWidth,
  defaultArtifactWidth,
  draggedArtifactWidth,
  maxArtifactWidth,
  readArtifactWidth,
} from './artifact-panel-size'

describe('artifact panel sizing', () => {
  it('opens at the Artifacts proportion, capped, on a wide screen', () => {
    expect(defaultArtifactWidth(1500)).toBe(560)
    expect(defaultArtifactWidth(1000)).toBe(450)
  })

  it('never lets the panel squeeze the chat below its minimum', () => {
    expect(maxArtifactWidth(1400)).toBe(1400 - CHAT_MIN_WIDTH)
    expect(clampArtifactWidth(5000, 1400)).toBe(1400 - CHAT_MIN_WIDTH)
    // A tiny viewport still yields the panel minimum rather than something negative.
    expect(maxArtifactWidth(500)).toBe(ARTIFACT_MIN_WIDTH)
  })

  it('never goes below the panel minimum', () => {
    expect(clampArtifactWidth(10, 1400)).toBe(ARTIFACT_MIN_WIDTH)
    expect(clampArtifactWidth(NaN, 1400)).toBe(defaultArtifactWidth(1400))
  })

  it('reads a remembered width and ignores junk', () => {
    expect(readArtifactWidth('700', 1400)).toBe(700)
    expect(readArtifactWidth('9999', 1400)).toBe(1400 - CHAT_MIN_WIDTH)
    expect(readArtifactWidth('abc', 1400)).toBe(defaultArtifactWidth(1400))
    expect(readArtifactWidth(null, 1400)).toBe(defaultArtifactWidth(1400))
    expect(readArtifactWidth('-5', 1400)).toBe(defaultArtifactWidth(1400))
  })

  it('drags from the left edge: pointer left widens, pointer right narrows, clamped', () => {
    expect(draggedArtifactWidth(560, 800, 700, 1400)).toBe(660)
    expect(draggedArtifactWidth(560, 800, 900, 1400)).toBe(460)
    expect(draggedArtifactWidth(560, 800, 0, 1400)).toBe(1400 - CHAT_MIN_WIDTH)
    expect(draggedArtifactWidth(560, 800, 1400, 1400)).toBe(ARTIFACT_MIN_WIDTH)
  })
})
