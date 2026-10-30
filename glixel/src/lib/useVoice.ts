import { useEffect, useRef, useState } from 'react'
import { listenOnce, recognitionErrorMessage, speak, speakableText, stopSpeaking, voiceSupport, type Listener } from './voice'

// Voice state for the composer. The microphone only opens on a tap, stops by
// itself after one utterance, and can be cancelled at any time. Before the
// first use in a page session the user is told where the audio goes.

export type MicState = 'idle' | 'consent' | 'listening' | 'processing' | 'heard' | 'error'

export function useVoiceInput(onText: (text: string) => void) {
  const [state, setState] = useState<MicState>('idle')
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [consented, setConsented] = useState(false) // memory only: asked again after a reload
  const listener = useRef<Listener | null>(null)
  const heard = useRef(false)
  const onTextRef = useRef(onText)
  useEffect(() => { onTextRef.current = onText })
  useEffect(() => () => listener.current?.cancel(), [])

  function begin() {
    setError(null); setInterim(''); heard.current = false
    const l = listenOnce({
      onInterim: setInterim,
      onFinal: text => { heard.current = true; onTextRef.current(text) },
      onError: code => { setError(recognitionErrorMessage(code)); setState('error') },
      onEnd: () => {
        listener.current = null
        setInterim('')
        setState(s => (s === 'error' || s === 'idle' ? s : heard.current ? 'heard' : 'idle'))
      },
    })
    if (!l) { setError('Voice input is not supported in this browser.'); setState('error'); return }
    listener.current = l
    setState('listening')
  }

  return {
    state, interim, error,
    supported: voiceSupport().input,
    tap() {
      if (state === 'listening') { listener.current?.stop(); setState('processing'); return }
      if (!consented) { setState('consent'); return }
      begin()
    },
    accept() { setConsented(true); begin() },
    cancel() { listener.current?.cancel(); listener.current = null; setInterim(''); setState('idle') },
    dismiss() { setState('idle'); setError(null) },
  }
}

export type VoiceInput = ReturnType<typeof useVoiceInput>

/** Read-aloud: off by default, prose only, always stoppable. */
export function useReadAloud() {
  const [enabled, setEnabled] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => () => stopSpeaking(), [])
  return {
    supported: voiceSupport().output,
    enabled,
    speaking,
    toggle() { if (enabled) { stopSpeaking(); setSpeaking(false) } setEnabled(!enabled) },
    say(markdown: string) {
      if (!enabled) return
      if (speak(speakableText(markdown), () => setSpeaking(false))) setSpeaking(true)
    },
    stop() { stopSpeaking(); setSpeaking(false) },
  }
}
