import type { VoiceInput } from '@/lib/useVoice'

// Voice controls for the composer: the microphone button and the panel that
// asks for consent, shows that the microphone is on, and reports the result.

export function MicButton({ voice, disabled }: { voice: VoiceInput; disabled?: boolean }) {
  if (!voice.supported) return null
  const active = voice.state === 'listening'
  return (
    <button
      type="button"
      className={`glx-mic ${active ? 'glx-mic-active' : ''}`}
      aria-label={active ? 'Stop listening' : 'Speak a message'}
      aria-pressed={active}
      disabled={disabled || voice.state === 'processing'}
      onClick={voice.tap}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  )
}

export function VoicePanel({ voice }: { voice: VoiceInput }) {
  switch (voice.state) {
    case 'consent':
      return (
        <div className="glx-voice-panel" role="dialog" aria-label="Voice input" data-testid="voice-consent">
          <p className="text-sm">Use voice input?</p>
          <p className="text-xs text-glx-muted mt-1">
            Speech is recognised by your browser, not by GLIXEL. In Chrome this uses Google&apos;s speech service, so your voice
            audio may be sent to Google. GLIXEL only receives the text, which you can review before sending. The browser will ask
            for microphone permission the first time; it listens only after you tap, and stops after you finish speaking.
          </p>
          <div className="flex gap-2 mt-2">
            <button type="button" className="glx-button" onClick={voice.accept}>Start listening</button>
            <button type="button" className="glx-button" onClick={voice.dismiss}>Not now</button>
          </div>
        </div>
      )
    case 'listening':
    case 'processing':
      return (
        <div className="glx-voice-panel glx-voice-live" role="status" data-testid="voice-listening">
          <p className="text-sm flex items-center gap-2">
            <span className="glx-rec-dot" aria-hidden="true" />
            {voice.state === 'listening' ? 'Microphone on — listening' : 'Processing what you said…'}
          </p>
          {voice.interim && <p className="text-sm text-glx-muted mt-1 break-words" data-testid="voice-interim">{voice.interim}</p>}
          <div className="flex gap-2 mt-2">
            {voice.state === 'listening' && <button type="button" className="glx-button" onClick={voice.tap}>Done</button>}
            <button type="button" className="glx-button" onClick={voice.cancel}>Cancel</button>
          </div>
        </div>
      )
    case 'heard':
      return (
        <p className="glx-voice-note" role="status" data-testid="voice-heard">
          Added to your message. Review it, then Send. <button type="button" className="glx-link" onClick={voice.dismiss}>OK</button>
        </p>
      )
    case 'error':
      return (
        <p className="glx-voice-note text-glx-warn" role="alert" data-testid="voice-error">
          {voice.error} <button type="button" className="glx-link" onClick={voice.dismiss}>OK</button>
        </p>
      )
    default:
      return null
  }
}
