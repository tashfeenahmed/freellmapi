import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Code2, Download, Eye, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
import { CodeBlock } from '@/components/code-block'
import { useI18n } from '@/i18n'
import { ARTIFACT_SANDBOX, artifactMimeType, artifactSrcDoc, type Artifact } from '@/lib/artifacts'
import { ARTIFACT_KEY_STEP, clampArtifactWidth, draggedArtifactWidth } from '@/lib/artifact-panel-size'

// The artifact side panel: what a reply built, running. Preview is a
// sandboxed iframe fed by srcdoc — scripts run, but the frame is an opaque
// origin with no reach into the dashboard, its token or its session. Code is
// the source, highlighted. Header: title, the two tabs on the centre line,
// and reload / copy / download / close.
//
// Size: the panel slides in from zero to its width and back out on close,
// and its left edge is a drag handle. The width the user settles on is the
// host's to remember (localStorage); this component only reports it. While
// dragging, the width transition is off (so the edge follows the pointer) and
// a glass sheet covers the iframe (which would otherwise swallow the pointer).

export type ArtifactTab = 'preview' | 'code'

export interface ArtifactPanelProps {
  artifact: Artifact
  /** False plays the exit animation; the host unmounts after it. */
  open: boolean
  width: number
  onWidthChange: (width: number) => void
  /** Called once the user lets go of the handle — the moment to persist. */
  onWidthCommit?: (width: number) => void
  onClose: () => void
}

export const ARTIFACT_PANEL_TRANSITION_MS = 280

export function ArtifactPanel({ artifact, open, width, onWidthChange, onWidthCommit, onClose }: ArtifactPanelProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<ArtifactTab>('preview')
  // Bumping the key remounts the iframe, which re-runs the document.
  const [run, setRun] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)
  // First paint at width 0, then the transition carries it to `width` — that
  // is the slide-in. A rAF callback runs BEFORE that frame paints, so flipping
  // there would skip the 0 state entirely; the width is forced through layout
  // first (reading offsetWidth) and the flip waits one more frame.
  const [mounted, setMounted] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let second = 0
    const first = requestAnimationFrame(() => {
      void boxRef.current?.offsetWidth
      second = requestAnimationFrame(() => setMounted(true))
    })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [])
  const title = artifact.title ?? t(artifact.kind === 'svg' ? 'playground.artifactSvg' : 'playground.artifactHtml')

  function download() {
    const blob = new Blob([artifact.code], { type: artifactMimeType(artifact.kind) })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = artifact.filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function onHandleDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startWidth: width }
    setDragging(true)
  }
  function onHandleMove(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    onWidthChange(draggedArtifactWidth(drag.current.startWidth, drag.current.startX, e.clientX, window.innerWidth))
  }
  function onHandleUp(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
    onWidthCommit?.(width)
  }
  function onHandleKey(e: KeyboardEvent<HTMLDivElement>) {
    // The handle is on the left edge: ArrowLeft grows the panel.
    const delta = e.key === 'ArrowLeft' ? ARTIFACT_KEY_STEP : e.key === 'ArrowRight' ? -ARTIFACT_KEY_STEP : 0
    if (!delta) return
    e.preventDefault()
    const next = clampArtifactWidth(width + delta, window.innerWidth)
    onWidthChange(next)
    onWidthCommit?.(next)
  }

  const shown = open && mounted
  const tabClass = (active: boolean) =>
    `inline-flex size-7 items-center justify-center rounded-lg transition-colors ${
      active ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }`

  return (
    // The outer box is what animates: its width goes 0 → width → 0. The inner
    // panel is pinned to the right at the full width, so the content never
    // reflows mid-slide — it is revealed, not resized.
    <div
      ref={boxRef}
      className={`relative shrink-0 overflow-hidden ${dragging ? '' : 'transition-[width] ease-out motion-reduce:transition-none'}`}
      style={{ width: shown ? width : 0, transitionDuration: dragging ? undefined : `${ARTIFACT_PANEL_TRANSITION_MS}ms` }}
      data-testid="artifact-panel"
      data-open={shown}
      aria-hidden={!open}
    >
      <aside
        className="absolute inset-y-0 right-0 flex flex-col border-s bg-card"
        style={{ width }}
        aria-label={title}
      >
        {/* The drag handle: a slim hit area straddling the left border. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('playground.artifactResize')}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onKeyDown={onHandleKey}
          className={`group/handle absolute inset-y-0 -left-1 z-10 w-2.5 cursor-col-resize outline-none focus-visible:bg-ring/30 ${dragging ? 'bg-ring/30' : 'hover:bg-ring/20'}`}
        >
          <div className="absolute inset-y-0 left-1 w-px bg-transparent transition-colors group-hover/handle:bg-ring/60" />
        </div>

        {/* Three cells, outer two equal, so the toggle sits on the panel's
            centre line whatever the title and action widths are. */}
        <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 py-1.5">
          <span className="min-w-0 truncate text-sm font-medium" title={title}>{title}</span>
          <div className="inline-flex items-center gap-0.5 rounded-xl border p-0.5" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'preview'} aria-label={t('playground.artifactPreview')} title={t('playground.artifactPreview')} className={tabClass(tab === 'preview')} onClick={() => setTab('preview')}>
              <Eye className="size-4" />
            </button>
            <button type="button" role="tab" aria-selected={tab === 'code'} aria-label={t('playground.artifactCode')} title={t('playground.artifactCode')} className={tabClass(tab === 'code')} onClick={() => setTab('code')}>
              <Code2 className="size-4" />
            </button>
          </div>
          <div className="flex items-center justify-end">
            {tab === 'preview' && (
              <Button variant="ghost" size="icon-sm" onClick={() => setRun(n => n + 1)} aria-label={t('playground.artifactReload')} title={t('playground.artifactReload')}>
                <RefreshCw className="size-4" />
              </Button>
            )}
            <CopyButton text={artifact.code} label={t('common.copy')} className="size-8 border-0 bg-transparent" />
            <Button variant="ghost" size="icon-sm" onClick={download} aria-label={t('playground.artifactDownload')} title={t('playground.artifactDownload')}>
              <Download className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('playground.artifactClose')} title={t('playground.artifactClose')}>
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {tab === 'preview' ? (
            <iframe
              key={`${artifact.id}:${run}`}
              title={title}
              sandbox={ARTIFACT_SANDBOX}
              srcDoc={artifactSrcDoc(artifact)}
              className="h-full w-full border-0 bg-white"
            />
          ) : (
            <pre className="h-full overflow-auto p-4">
              <CodeBlock code={artifact.code} language={artifact.language || artifact.kind} />
            </pre>
          )}
          {/* While dragging, keep the pointer out of the iframe. */}
          {dragging && <div className="absolute inset-0 z-10" aria-hidden="true" />}
        </div>
      </aside>
    </div>
  )
}
