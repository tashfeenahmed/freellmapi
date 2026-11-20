import { useEffect, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react'
import { Liquid } from 'liquid-gooey'
import { ArrowUp, Globe, Paperclip, Plus } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { DictationButton, type DictationButtonProps, type DictationPhase } from './dictation-button'
import { DictationWave } from './dictation-wave'
import {
  COMPOSER_BRIDGE,
  COMPOSER_CORNER_PX,
  COMPOSER_EDGE,
  composerHeight,
  sendButtonInteractive,
  sendButtonOffset,
} from '@/lib/composer-geometry'

// The Playground's bottom input as one body of liquid: the bar and the send
// button share a goo silhouette. THE MORPH PATTERN — the library owns x: it
// animates the button and its silhouette in perfect sync, so while the button
// is leaving the two are still one body of liquid, necking thinner until the
// goo gives up. The bar never moves; the button walks out from under its
// right edge once there is something to send, and slides back under it when
// the text is cleared.
//
// THE FILL MUST BE OPAQUE. The goo is a blur then a steep alpha contrast, so a
// translucent fill would not look faint, it would not be drawn at all. --muted
// is a solid oklch in both themes, and it is the whole separation: the bar
// reads against the page by tone, with no border or ring anywhere.
//
// Morph positions its item with a CSS transform in LAYOUT pixels, which is
// why this component carries no scale correction of its own.

export interface LiquidComposerProps {
  inputRef: RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  placeholder: string
  /** True when there is text or an attachment to send. */
  hasContent: boolean
  loading: boolean
  onSend: () => void
  onAttach: () => void
  labels: { add: string; attach: string; send: string; sending: string }
  /** Speech to text for the mic; the transcript is appended to `value`. */
  dictation: Pick<DictationButtonProps, 'onUnavailable' | 'model' | 'apiKey' | 'onText'>
  /** The web search switch in the + menu (#1174). While it is on, the + turns
   *  blue with a small dot instead of a chip in the field, so the input stays clear. */
  webSearch?: { enabled: boolean; available: boolean; label: string; unavailableHint: string; onToggle: (on: boolean) => void }
}

export function LiquidComposer({
  inputRef, value, onChange, onKeyDown, onPaste, placeholder, hasContent, loading, onSend, onAttach, labels, dictation, webSearch,
}: LiquidComposerProps) {
  // Set from input events; an empty value never counts as grown, so a
  // programmatic clear (send, new chat) drops back to one line by itself.
  const [grownByInput, setGrown] = useState(false)
  const grown = grownByInput && value !== ''
  const [dictationPhase, setDictationPhase] = useState<DictationPhase>('idle')
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const recording = dictationPhase === 'recording' && micStream !== null
  // The mic only ever fades — no scale, no travel. It shows while the bar is
  // empty (and for as long as a recording or transcription is in progress),
  // and stops being there once there is something to send.
  const showMic = !hasContent || dictationPhase !== 'idle'

  // The textarea's inline height is set from input events, which a
  // programmatic clear never fires — so the DOM height is reset here.
  useEffect(() => {
    if (value !== '') return
    const el = inputRef.current
    if (el) el.style.height = 'auto'
  }, [value, inputRef])
  const interactive = sendButtonInteractive(hasContent, loading)

  return (
    <Liquid
      blur={COMPOSER_BRIDGE}
      contrast={COMPOSER_EDGE}
      fill="var(--muted)"
      className={`flex gap-2 ${grown ? 'items-end' : 'items-center'}`}
      data-testid="liquid-composer"
    >
      {/* The bar: never moves. Its own background is transparent — the
          silhouette layer paints the fill. */}
      <Liquid.Item className="min-w-0 flex-1">
        <div
          className={`flex gap-1 ps-1 pe-2 py-1 ${grown ? 'items-end' : 'items-center'}`}
          style={{ borderRadius: COMPOSER_CORNER_PX }}
        >
          {/* One + for everything that goes with the message: files, and the
              web search switch (which the settings rail also carries). */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={`${buttonVariants({ variant: 'ghost', size: 'icon' })} relative shrink-0 rounded-full text-muted-foreground hover:text-foreground data-popup-open:text-foreground ${grown ? 'mb-0.5' : ''}`}
              disabled={loading}
              aria-label={webSearch?.enabled ? `${labels.add} · ${webSearch.label}` : labels.add}
              title={webSearch?.enabled ? `${labels.add} · ${webSearch.label}` : labels.add}
            >
              <Plus className={`size-4 ${webSearch?.enabled ? 'text-sky-600 dark:text-sky-300' : ''}`} />
              {webSearch?.enabled && (
                <span
                  data-testid="web-search-indicator"
                  className="pointer-events-none absolute top-1.5 right-1.5 size-1.5 rounded-full bg-sky-500"
                />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
              <DropdownMenuItem onClick={onAttach}>
                <Paperclip />
                {labels.attach}
              </DropdownMenuItem>
              {webSearch && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    closeOnClick={false}
                    disabled={!webSearch.available}
                    onClick={() => webSearch.onToggle(!webSearch.enabled)}
                    title={webSearch.available ? undefined : webSearch.unavailableHint}
                    aria-checked={webSearch.enabled}
                    role="menuitemcheckbox"
                  >
                    <Globe />
                    <span className="flex-1">{webSearch.label}</span>
                    <Switch
                      size="sm"
                      checked={webSearch.enabled}
                      tabIndex={-1}
                      aria-hidden
                      className="pointer-events-none"
                    />
                  </DropdownMenuItem>
                  {!webSearch.available && (
                    <p className="px-1.5 pt-0.5 pb-1 text-[11px] leading-snug text-muted-foreground">{webSearch.unavailableHint}</p>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* While the mic is open the field shows the voice, not the text:
              the textarea keeps its value and size, the wave paints over it. */}
          {/* A flex wrapper: an inline textarea inside a block div gets a
              baseline gap under it, which pushed the field 3px off the buttons'
              centre line. */}
          <div className="relative flex min-w-0 flex-1 items-center">
          <textarea
            ref={inputRef}
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder}
            rows={1}
            className={`block min-h-[32px] w-full resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground transition-opacity ${recording ? 'opacity-0' : ''}`}
            style={{ height: 'auto', overflow: 'hidden' }}
            onInput={e => {
              const el = e.target as HTMLTextAreaElement
              el.style.height = 'auto'
              const next = composerHeight(el.scrollHeight)
              el.style.height = `${next.height}px`
              setGrown(next.grown)
            }}
          />
          {recording && (
            <DictationWave stream={micStream} className="pointer-events-none absolute inset-y-0 left-1 right-1 h-full w-[calc(100%-0.5rem)] text-foreground" />
          )}
          </div>
          <div data-show={showMic} className="cmd-mic shrink-0 transition-opacity duration-150 ease-out data-[show=false]:pointer-events-none data-[show=false]:opacity-0">
            <DictationButton
              {...dictation}
              disabled={loading}
              onPhaseChange={setDictationPhase}
              onStreamChange={setMicStream}
            />
          </div>
        </div>
      </Liquid.Item>

      {/* The button: the one thing that moves. Its content only ever fades —
          no scale, no travel of its own — the silhouette does the travelling.
          While parked under the bar its wrapper sits exactly over the mic, so
          the wrapper (not just the faded button) must let clicks through. */}
      <Liquid.Item x={sendButtonOffset(hasContent)} className={hasContent ? undefined : 'pointer-events-none'}>
        <button
          type="button"
          onClick={onSend}
          disabled={!interactive}
          tabIndex={hasContent ? 0 : -1}
          aria-hidden={!hasContent}
          aria-label={loading ? labels.sending : labels.send}
          title={loading ? labels.sending : labels.send}
          data-show={hasContent}
          className="flex size-10 items-center justify-center rounded-full text-foreground outline-none transition-opacity duration-150 ease-out hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default data-[show=false]:pointer-events-none data-[show=false]:opacity-0"
        >
          <ArrowUp className={`size-4 ${loading ? 'opacity-40' : ''}`} />
        </button>
      </Liquid.Item>
    </Liquid>
  )
}
