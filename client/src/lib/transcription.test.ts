import { describe, it, expect } from 'vitest'
import {
  appendDictation,
  availableTranscriptionModels,
  hasTranscription,
  pickRecordingMimeType,
  recordingFilename,
  resolveDictationModel,
  transcriptionOptions,
  type TranscriptionModelRow,
} from './transcription'

function row(over: Partial<TranscriptionModelRow> & Pick<TranscriptionModelRow, 'id' | 'platform' | 'modelId'>): TranscriptionModelRow {
  return { displayName: over.modelId, modality: 'transcription', enabled: true, keyCount: 1, ...over }
}

const MODELS: TranscriptionModelRow[] = [
  row({ id: 1, platform: 'groq', modelId: 'whisper-large-v3', displayName: 'Whisper Large v3' }),
  row({ id: 2, platform: 'openrouter', modelId: 'whisper-large-v3', displayName: 'Whisper Large v3' }),
  row({ id: 3, platform: 'cloudflare', modelId: 'whisper-tiny-en', displayName: 'Whisper Tiny (en)' }),
  row({ id: 4, platform: 'nvidia', modelId: 'parakeet', keyCount: 0 }),           // no key
  row({ id: 5, platform: 'groq', modelId: 'whisper-large-v3-turbo', enabled: false }), // switched off
  row({ id: 6, platform: 'pollinations', modelId: 'openai-audio', modality: 'audio' }), // wrong direction
]

describe('availableTranscriptionModels / hasTranscription', () => {
  it('keeps only enabled transcription rows on a keyed platform', () => {
    expect(availableTranscriptionModels(MODELS).map(m => m.id)).toEqual([1, 2, 3])
    expect(hasTranscription(MODELS)).toBe(true)
    expect(hasTranscription(MODELS.filter(m => m.id > 3))).toBe(false)
    expect(hasTranscription([])).toBe(false)
  })
})

describe('transcriptionOptions', () => {
  it('lists Auto first, then one option per model id with its hosts', () => {
    const opts = transcriptionOptions(MODELS, 'Auto')
    expect(opts.map(o => o.value)).toEqual(['auto', 'whisper-large-v3', 'whisper-tiny-en'])
    expect(opts[1]).toMatchObject({ label: 'Whisper Large v3', sub: '2 providers', platforms: ['groq', 'openrouter'] })
    expect(opts[2]).toMatchObject({ sub: 'cloudflare' })
  })
  it('is just Auto when nothing is usable', () => {
    expect(transcriptionOptions([], 'Auto')).toEqual([{ value: 'auto', label: 'Auto' }])
  })
})

describe('resolveDictationModel', () => {
  it('honours a usable saved choice and falls back to auto otherwise', () => {
    expect(resolveDictationModel('whisper-tiny-en', MODELS)).toBe('whisper-tiny-en')
    expect(resolveDictationModel('parakeet', MODELS)).toBe('auto')        // lost its key
    expect(resolveDictationModel('whisper-large-v3-turbo', MODELS)).toBe('auto') // disabled
    expect(resolveDictationModel(null, MODELS)).toBe('auto')
    expect(resolveDictationModel('auto', MODELS)).toBe('auto')
  })
})

describe('recording container', () => {
  it('prefers webm/opus and names the file to match', () => {
    expect(pickRecordingMimeType(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickRecordingMimeType(t => t === 'audio/mp4')).toBe('audio/mp4')
    expect(pickRecordingMimeType(() => false)).toBeUndefined()
    expect(recordingFilename('audio/webm;codecs=opus')).toBe('dictation.webm')
    expect(recordingFilename('audio/mp4')).toBe('dictation.m4a')
    expect(recordingFilename('audio/ogg;codecs=opus')).toBe('dictation.ogg')
    expect(recordingFilename(undefined)).toBe('dictation.webm')
  })
})

describe('appendDictation', () => {
  it('joins spoken text onto typed text with a single space', () => {
    expect(appendDictation('', ' hello ')).toBe('hello')
    expect(appendDictation('Dear team, ', 'thanks for today')).toBe('Dear team, thanks for today')
    expect(appendDictation('typed', '   ')).toBe('typed')
  })
})
