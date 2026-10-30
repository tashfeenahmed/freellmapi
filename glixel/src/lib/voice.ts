// Browser-native voice for GLIXEL: the Web Speech API's SpeechRecognition for
// input and speechSynthesis for output. No audio ever reaches the FreeLLMAPI
// server; GLIXEL only receives the recognised text.
//
// Where the audio goes is up to the browser. Chrome's recognition is
// server-based (Google's speech service), which is why the app asks for
// consent before the first use. Support differs per browser, so everything
// here is feature-detected and typed chat keeps working without it.

export interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface VoiceSupport { input: boolean; output: boolean }
export function voiceSupport(): VoiceSupport {
  return {
    input: typeof window !== 'undefined' && recognitionCtor() !== null,
    output: typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function',
  }
}

export interface Listener { stop(): void; cancel(): void }

// One utterance per tap: continuous=false, so the browser stops listening by
// itself after a pause. Nothing restarts it.
export function listenOnce(handlers: {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onError: (code: string) => void
  onEnd: () => void
}): Listener | null {
  const Ctor = recognitionCtor()
  if (!Ctor) return null
  const rec = new Ctor()
  rec.lang = navigator.language || 'en-US'
  rec.interimResults = true
  rec.continuous = false
  rec.maxAlternatives = 1
  let finalText = ''
  let cancelled = false
  rec.onresult = e => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) finalText += r[0].transcript
      else interim += r[0].transcript
    }
    if (!cancelled) handlers.onInterim((finalText + interim).trim())
  }
  rec.onerror = e => { if (!cancelled && e.error !== 'aborted') handlers.onError(e.error) }
  rec.onend = () => {
    if (!cancelled && finalText.trim()) handlers.onFinal(finalText.trim())
    handlers.onEnd()
  }
  rec.start()
  return {
    stop: () => rec.stop(),
    cancel: () => { cancelled = true; rec.abort() },
  }
}

export function recognitionErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow the microphone for this site in the browser\'s site settings, then try again.'
    case 'no-speech': return 'No speech was heard. Tap the microphone and speak again.'
    case 'audio-capture': return 'No microphone was found, or another app is using it.'
    case 'network': return 'The browser\'s speech service could not be reached. Check the connection, or type instead.'
    case 'language-not-supported': return 'This browser cannot recognise speech in your language.'
    default: return 'Voice input stopped unexpectedly. You can type instead.'
  }
}

export const SPEAK_MAX_CHARS = 600

// What GLIXEL reads aloud: prose only. Code, tables, links and images are
// skipped (replaced by a short note) and long replies are cut at a sentence
// boundary, since the full answer is always on screen.
export function speakableText(markdown: string): string {
  let t = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' (code block on screen) ')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/(\(code block on screen\)\s*)+/g, '(code block on screen) ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > SPEAK_MAX_CHARS) {
    const cut = t.slice(0, SPEAK_MAX_CHARS)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    t = (end > SPEAK_MAX_CHARS / 3 ? cut.slice(0, end + 1) : cut) + ' The rest is on screen.'
  }
  return t
}

export function speak(text: string, onEnd: () => void): boolean {
  if (!voiceSupport().output || !text) return false
  window.speechSynthesis.cancel()
  const u = new window.SpeechSynthesisUtterance(text)
  u.lang = navigator.language || 'en-US'
  u.onend = onEnd
  u.onerror = onEnd
  window.speechSynthesis.speak(u)
  return true
}

export function stopSpeaking(): void {
  if (voiceSupport().output) window.speechSynthesis.cancel()
}
