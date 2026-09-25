import type { ModelComboOption } from '@/components/model-combobox'

// Which speech-to-text models the Playground's mic can use, and how the
// dictation-model setting resolves against them. Pure, so the rules are
// testable without a browser or a MediaRecorder.

/** The slice of GET /api/media the mic needs. */
export interface TranscriptionModelRow {
  id: number
  platform: string
  modelId: string
  displayName: string
  modality: 'image' | 'video' | 'audio' | 'transcription'
  enabled: boolean
  keyCount: number
}

export const DICTATION_AUTO = 'auto'
export const DICTATION_MODEL_STORAGE_KEY = 'playground.transcriptionModel'

/** Transcription rows that can actually route: enabled, on a platform with a key. */
export function availableTranscriptionModels(models: readonly TranscriptionModelRow[]): TranscriptionModelRow[] {
  return models.filter(m => m.modality === 'transcription' && m.enabled && m.keyCount > 0)
}

export function hasTranscription(models: readonly TranscriptionModelRow[]): boolean {
  return availableTranscriptionModels(models).length > 0
}

/** Picker options: Auto first, then every usable model, once per model id
 *  (the same Whisper on two hosts is one choice; the router picks the host). */
export function transcriptionOptions(models: readonly TranscriptionModelRow[], autoLabel: string): ModelComboOption[] {
  const byId = new Map<string, TranscriptionModelRow[]>()
  for (const m of availableTranscriptionModels(models)) {
    const list = byId.get(m.modelId)
    if (list) list.push(m)
    else byId.set(m.modelId, [m])
  }
  const options: ModelComboOption[] = [{ value: DICTATION_AUTO, label: autoLabel }]
  for (const [modelId, rows] of byId) {
    const platforms = [...new Set(rows.map(r => r.platform))]
    options.push({
      value: modelId,
      label: rows[0].displayName || modelId,
      sub: platforms.length === 1 ? platforms[0] : `${platforms.length} providers`,
      platforms,
    })
  }
  return options
}

/** The `model` the mic sends: the saved choice while it is still usable,
 *  otherwise Auto — a model that lost its key must not make dictation fail. */
export function resolveDictationModel(choice: string | null | undefined, models: readonly TranscriptionModelRow[]): string {
  if (!choice || choice === DICTATION_AUTO) return DICTATION_AUTO
  return availableTranscriptionModels(models).some(m => m.modelId === choice) ? choice : DICTATION_AUTO
}

/** A recording container the browser can produce and providers accept, in
 *  preference order. Returns undefined when nothing is supported (older
 *  Safari), in which case MediaRecorder picks its own default. */
export function pickRecordingMimeType(isSupported: (type: string) => boolean): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(isSupported)
}

/** File name for the upload, matching the container so the provider can sniff it. */
export function recordingFilename(mimeType: string | undefined): string {
  if (!mimeType) return 'dictation.webm'
  if (mimeType.startsWith('audio/mp4')) return 'dictation.m4a'
  if (mimeType.startsWith('audio/ogg')) return 'dictation.ogg'
  return 'dictation.webm'
}

/** Append dictated text to what is already typed, with one space between. */
export function appendDictation(existing: string, text: string): string {
  const spoken = text.trim()
  if (!spoken) return existing
  if (!existing.trim()) return spoken
  return `${existing.replace(/\s+$/, '')} ${spoken}`
}
