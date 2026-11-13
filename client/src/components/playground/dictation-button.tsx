import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { pickRecordingMimeType, recordingFilename } from '@/lib/transcription'

// The mic in the composer. One click records, the next stops and sends the
// clip to /v1/audio/transcriptions — the gateway's own speech-to-text route,
// so key scope, cooldowns and the Auto/pinned choice all behave exactly as
// they do for an API client. The text comes back into the composer; nothing
// is sent to the chat model until the user presses send.
//
// With no usable transcription model the button still shows, so the feature
// is discoverable, and a click explains what to add instead of failing.

// 'requesting' covers the browser's permission prompt: the button is disabled
// so a second click cannot open a second microphone nobody can stop.
export type DictationPhase = 'idle' | 'requesting' | 'recording' | 'transcribing'

export interface DictationButtonProps {
  /** Whether at least one enabled transcription model has a key. */
  available: boolean
  /** `auto` or a transcription model id, already resolved against availability. */
  model: string
  /** The unified API key, for the /v1 route. */
  apiKey: string | null | undefined
  disabled?: boolean
  /** Receives the transcript; the composer appends it to what is typed. */
  onText: (text: string) => void
  onPhaseChange?: (phase: DictationPhase) => void
  /** The open microphone stream while recording, null otherwise — for the wave. */
  onStreamChange?: (stream: MediaStream | null) => void
  className?: string
}

export function DictationButton({ available, model, apiKey, disabled, onText, onPhaseChange, onStreamChange, className }: DictationButtonProps) {
  const { t } = useI18n()
  const [phase, setPhaseState] = useState<DictationPhase>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  // False once unmounted: a mic granted or a clip stopped after that is
  // closed and dropped, never recorded, sent or reported to the parent.
  const mountedRef = useRef(true)
  const setPhase = (next: DictationPhase) => {
    if (!mountedRef.current) return
    setPhaseState(next)
    onPhaseChange?.(next)
  }

  // Never leave a microphone open behind an unmounted button.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') rec.stop()
      rec?.stream.getTracks().forEach(track => track.stop())
    }
  }, [])

  async function start() {
    if (!available) {
      toast.info(t('playground.dictationUnavailable'))
      return
    }
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast.error(t('playground.dictationFailed', { reason: 'MediaRecorder is not supported in this browser' }))
      return
    }
    setPhase('requesting')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err: unknown) {
      toast.error(t('playground.dictationFailed', { reason: err instanceof Error ? err.message : String(err) }))
      setPhase('idle')
      return
    }
    const release = () => stream.getTracks().forEach(track => track.stop())
    if (!mountedRef.current) {
      release()
      return
    }
    const mimeType = pickRecordingMimeType(type => MediaRecorder.isTypeSupported(type))
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        onStreamChange?.(null)
        release()
        if (!mountedRef.current) return
        void transcribe(new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' }))
      }
      recorder.start()
    } catch (err: unknown) {
      // The mic is already open: close it, or the browser keeps showing it in use.
      release()
      toast.error(t('playground.dictationFailed', { reason: err instanceof Error ? err.message : String(err) }))
      setPhase('idle')
      return
    }
    recorderRef.current = recorder
    onStreamChange?.(stream)
    setPhase('recording')
  }

  function stop() {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    recorderRef.current = null
  }

  async function transcribe(blob: Blob) {
    setPhase('transcribing')
    try {
      if (blob.size === 0) throw new Error('nothing was recorded')
      const form = new FormData()
      form.append('file', blob, recordingFilename(blob.type))
      form.append('model', model)
      form.append('response_format', 'json')
      const headers: Record<string, string> = {}
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const res = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers, body: form })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message || `HTTP ${res.status}`)
      }
      const data = await res.json() as { text?: string }
      if (mountedRef.current) onText(data.text ?? '')
    } catch (err: unknown) {
      toast.error(t('playground.dictationFailed', { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setPhase('idle')
    }
  }

  const label = phase === 'recording'
    ? t('playground.dictationStop')
    : phase === 'transcribing'
      ? t('playground.dictationTranscribing')
      : t('playground.dictate')

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={`shrink-0 rounded-full ${phase === 'recording' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'} ${className ?? ''}`}
      onClick={() => (phase === 'recording' ? stop() : void start())}
      // A busy composer blocks starting, never stopping: the mic must close.
      disabled={phase === 'requesting' || phase === 'transcribing' || (disabled && phase !== 'recording')}
      aria-label={label}
      title={label}
      aria-pressed={phase === 'recording'}
      data-phase={phase}
    >
      {phase === 'transcribing'
        ? <Loader2 className="size-4 animate-spin" />
        : phase === 'recording'
          ? <Square className="size-3.5 fill-current" />
          : <Mic className="size-4" />}
    </Button>
  )
}
