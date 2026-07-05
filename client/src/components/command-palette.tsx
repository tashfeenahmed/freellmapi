import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AudioLines,
  Boxes,
  ChartColumn,
  Copy,
  Image as ImageIcon,
  KeyRound,
  Layers,
  MessageSquare,
  Moon,
  Search,
  Sparkles,
  SquareTerminal,
  Zap,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { apiBaseUrl } from '@/components/api-usage'
import { useI18n } from '@/i18n'
import type { FallbackEntry } from '@/lib/routing'

// Open the palette from anywhere (navbar button); same custom-event idiom as
// UNAUTHORIZED_EVENT in lib/api.ts.
export const COMMAND_PALETTE_EVENT = 'freellmapi:command-palette'
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT))
}

interface Command {
  id: string
  group: 'pages' | 'actions' | 'models'
  label: string
  keywords: string
  icon: React.ComponentType<{ className?: string }>
  run: () => void
}

// Cmd+K / Ctrl+K palette: jump to any page or model, toggle theme, copy the
// unified key or base URL. Zero-dep overlay; list is keyboard-driven
// (arrows + Enter) with proper listbox semantics.
export function CommandPalette() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const openRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset happens on show (not in an effect watching `open`): the palette
  // always opens blank with the first row active.
  const show = useCallback(() => {
    openRef.current = true
    setQuery('')
    setActive(0)
    setOpen(true)
    // Focus after the overlay paints.
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])
  const hide = useCallback(() => {
    openRef.current = false
    setOpen(false)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (openRef.current) hide()
        else show()
      } else if (e.key === 'Escape' && openRef.current) {
        hide()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(COMMAND_PALETTE_EVENT, show)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(COMMAND_PALETTE_EVENT, show)
    }
  }, [show, hide])

  // Model index + unified key load lazily, only while the palette is open.
  const { data: entries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
    enabled: open,
  })
  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
    enabled: open,
  })

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => navigate(to)
    const pages: Command[] = [
      { id: 'p-chat', group: 'pages', label: t('models.chatModelsTab'), keywords: 'models chat routing fallback', icon: MessageSquare, run: go('/models/chat') },
      { id: 'p-embeddings', group: 'pages', label: t('models.embeddingsTab'), keywords: 'models embeddings vectors', icon: Layers, run: go('/models/embeddings') },
      { id: 'p-image', group: 'pages', label: t('models.imageTab'), keywords: 'models image generation', icon: ImageIcon, run: go('/models/image') },
      { id: 'p-audio', group: 'pages', label: t('models.audioTab'), keywords: 'models audio speech tts', icon: AudioLines, run: go('/models/audio') },
      { id: 'p-fusion', group: 'pages', label: t('models.fusionTab'), keywords: 'models fusion synthesis panel judge', icon: Zap, run: go('/models/fusion') },
      { id: 'p-playground', group: 'pages', label: t('nav.playground'), keywords: 'playground test chat try', icon: SquareTerminal, run: go('/playground') },
      { id: 'p-keys', group: 'pages', label: t('nav.keys'), keywords: 'keys providers api tokens', icon: KeyRound, run: go('/keys') },
      { id: 'p-analytics', group: 'pages', label: t('nav.analytics'), keywords: 'analytics usage stats savings latency', icon: ChartColumn, run: go('/analytics') },
      { id: 'p-premium', group: 'pages', label: t('nav.premium'), keywords: 'premium catalog license subscription', icon: Sparkles, run: go('/premium') },
    ]
    const actions: Command[] = [
      {
        id: 'a-theme',
        group: 'actions',
        label: t('palette.toggleTheme'),
        keywords: 'theme dark light mode toggle',
        icon: Moon,
        run: () => {
          const next = !document.documentElement.classList.contains('dark')
          document.documentElement.classList.toggle('dark', next)
          try { localStorage.setItem('theme', next ? 'dark' : 'light') } catch { /* ignore */ }
        },
      },
      {
        id: 'a-copy-key',
        group: 'actions',
        label: t('setup.copyKey'),
        keywords: 'copy api key unified token',
        icon: Copy,
        run: () => {
          if (!keyData?.apiKey) return
          void navigator.clipboard?.writeText(keyData.apiKey)
          toast.success(t('setup.copiedKey'))
        },
      },
      {
        id: 'a-copy-url',
        group: 'actions',
        label: t('setup.copyUrl'),
        keywords: 'copy base url endpoint',
        icon: Copy,
        run: () => {
          void navigator.clipboard?.writeText(apiBaseUrl())
          toast.success(t('setup.copiedUrl'))
        },
      },
    ]
    // One entry per logical model (configured providers only).
    const seen = new Set<string>()
    const models: Command[] = []
    for (const e of entries) {
      if (e.keyCount === 0) continue
      const canonical = e.canonicalId ?? e.modelId
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const label = e.groupLabel ?? e.displayName
      models.push({
        id: `m-${canonical}`,
        group: 'models',
        label,
        keywords: `${canonical} ${e.modelId} ${e.platform}`,
        icon: Boxes,
        run: go(`/models/chat/${encodeURIComponent(canonical)}`),
      })
    }
    return [...pages, ...actions, ...models]
  }, [entries, keyData, navigate, t])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands.filter(c => c.group !== 'models').concat(commands.filter(c => c.group === 'models').slice(0, 5))
    const matches = commands.filter(c => c.label.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q))
    // Pages/actions first, then at most 8 model hits so the list stays scannable.
    return matches.filter(c => c.group !== 'models').concat(matches.filter(c => c.group === 'models').slice(0, 8))
  }, [commands, query])

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  function runCommand(cmd: Command) {
    hide()
    cmd.run()
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(a => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(a => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && filtered[active]) {
      e.preventDefault()
      runCommand(filtered[active])
    }
  }

  const groups: { key: Command['group']; labelKey: string }[] = [
    { key: 'pages', labelKey: 'palette.groupPages' },
    { key: 'actions', labelKey: 'palette.groupActions' },
    { key: 'models', labelKey: 'palette.groupModels' },
  ]

  let flatIndex = -1

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 px-4 pt-[18vh] backdrop-blur-[2px]"
      onMouseDown={e => {
        if (e.target === e.currentTarget) hide()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        className="w-full max-w-lg overflow-hidden rounded-2xl border bg-popover shadow-2xl animate-in fade-in zoom-in-95 duration-150"
        onKeyDown={onListKeyDown}
      >
        <div className="flex items-center gap-2.5 border-b px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setActive(0)
            }}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[active] ? `cmd-${filtered[active].id}` : undefined}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('palette.empty')}</p>
          )}
          {groups.map(g => {
            const items = filtered.filter(c => c.group === g.key)
            if (items.length === 0) return null
            return (
              <div key={g.key} className="mb-1 last:mb-0">
                <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {t(g.labelKey)}
                </p>
                {items.map(cmd => {
                  flatIndex += 1
                  const index = flatIndex
                  const isActive = index === active
                  const Icon = cmd.icon
                  return (
                    <button
                      key={cmd.id}
                      id={`cmd-${cmd.id}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      data-index={index}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => runCommand(cmd)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                        isActive ? 'bg-muted text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
