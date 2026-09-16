// Sizing rules for the artifact panel: how wide it may be, what it opens at,
// and where the chosen width is remembered. Pure, so the clamp and the
// storage round-trip are tested without a DOM.

export const ARTIFACT_WIDTH_STORAGE_KEY = 'playground.artifactWidth'
/** Narrower than this and the header actions collide with the tabs. */
export const ARTIFACT_MIN_WIDTH = 320
/** What the chat column must keep, so the panel can never push it away. */
export const CHAT_MIN_WIDTH = 360
/** First open, before the user has dragged: the Artifacts-panel proportion. */
export const ARTIFACT_DEFAULT_FRACTION = 0.45
export const ARTIFACT_DEFAULT_MAX = 560
/** Keyboard resize step on the handle, px. */
export const ARTIFACT_KEY_STEP = 24

/** Largest width the viewport allows while the chat keeps its minimum. */
export function maxArtifactWidth(viewportWidth: number): number {
  return Math.max(ARTIFACT_MIN_WIDTH, Math.floor(viewportWidth - CHAT_MIN_WIDTH))
}

export function clampArtifactWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return defaultArtifactWidth(viewportWidth)
  return Math.round(Math.min(maxArtifactWidth(viewportWidth), Math.max(ARTIFACT_MIN_WIDTH, width)))
}

export function defaultArtifactWidth(viewportWidth: number): number {
  return clampArtifactWidth(Math.min(ARTIFACT_DEFAULT_MAX, viewportWidth * ARTIFACT_DEFAULT_FRACTION), viewportWidth)
}

/** The remembered width, or the default when nothing valid is stored. */
export function readArtifactWidth(stored: string | null | undefined, viewportWidth: number): number {
  const n = stored == null ? NaN : Number(stored)
  return Number.isFinite(n) && n > 0 ? clampArtifactWidth(n, viewportWidth) : defaultArtifactWidth(viewportWidth)
}

/** Width after a drag: the handle is on the LEFT edge, so moving the pointer
 *  left (negative dx) makes the panel wider. */
export function draggedArtifactWidth(startWidth: number, startX: number, clientX: number, viewportWidth: number): number {
  return clampArtifactWidth(startWidth + (startX - clientX), viewportWidth)
}
