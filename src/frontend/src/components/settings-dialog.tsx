import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronsUpDown,
  ExternalLink,
  FlaskConical,
  Gauge,
  Info,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Sun,
  Wrench,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { UPDATE_CHECK_CHANGED_EVENT } from '@/components/update-reminder'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/tooltip'
import { SUPPORTED_LOCALES, type Locale, useI18n } from '@/i18n'
import { type Theme, useTheme } from '@/theme-context'
import { apiFetch } from '@/lib/api'

// Small info affordance used next to labels a first-time user can't be expected
// to understand. It's a real <button> so it reaches the tooltip by keyboard
// (the shared Tooltip opens on focus as well as hover); self-evident settings
// like language and theme deliberately have none.
function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip text={text}>
      <button
        type="button"
        aria-label={text}
        onClick={event => event.preventDefault()}
        className="inline-flex rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Info className="size-3.5" />
      </button>
    </Tooltip>
  )
}

// One settings row: label (plus optional info hint) on the start edge, control
// on the end edge, stacking on narrow widths. Every row in the dialog uses this
// so labels, spacing and alignment stay identical across sections.
function Row({
  label,
  hint,
  control,
  children,
}: {
  label: string
  hint?: string
  /** Inline control, aligned with the label. */
  control?: ReactNode
  /** Full-width control rendered under the label. */
  children?: ReactNode
}) {
  return (
    <div className="border-b border-border/60 py-4 last:border-b-0 last:pb-0">
      <div className={control ? 'flex flex-wrap items-center justify-between gap-x-6 gap-y-2' : 'space-y-2.5'}>
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{label}</span>
          {hint && <InfoHint text={hint} />}
        </div>
        {control ?? children}
      </div>
    </div>
  )
}

function SectionHeader({ title, description, hint }: { title: string; description?: string; hint?: string }) {
  return (
    <div className="mb-5 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <h2 className="font-heading text-base leading-snug font-medium">{title}</h2>
        {hint && <InfoHint text={hint} />}
      </div>
      {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  )
}

// Shared pill-bar idiom (same visual as SegmentedControl, with room for icons).
function OptionBar<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className,
}: {
  value: T
  onValueChange: (value: T) => void
  options: Array<{ value: T; label: string; icon?: typeof Monitor }>
  ariaLabel: string
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`grid gap-1 rounded-xl border p-1 ${className ?? ''}`}>
      {options.map(option => {
        const Icon = option.icon
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onValueChange(option.value)}
            className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors ${
              selected
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {Icon && <Icon className="size-3.5 shrink-0" />}
            <span className="truncate">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function LanguageCombobox() {
  const { locale, setLocale, t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const languages = useMemo(() => {
    const collator = new Intl.Collator(locale, { sensitivity: 'base' })
    return SUPPORTED_LOCALES
      .map(code => ({ code, name: t(`languages.${code}`) }))
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [locale, t])

  const normalizedQuery = query.trim().toLocaleLowerCase(locale)
  const filtered = normalizedQuery
    ? languages.filter(({ code, name }) =>
        `${name} ${code}`.toLocaleLowerCase(locale).includes(normalizedQuery),
      )
    : languages
  const currentName = languages.find(language => language.code === locale)?.name ?? locale

  function selectLocale(next: Locale) {
    setLocale(next)
    setOpen(false)
    setQuery('')
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(current => Math.min(current + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(current => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' && filtered[active]) {
      event.preventDefault()
      selectLocale(filtered[active].code)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={nextOpen => {
        setOpen(nextOpen)
        setQuery('')
        setActive(0)
      }}
    >
      <PopoverTrigger
        aria-label={t('settings.language')}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-64 dark:bg-input/30"
      >
        <span className="truncate">{currentName}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(340px,calc(100vw-3rem))] p-0" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder={t('settings.searchLanguage')}
            aria-label={t('settings.searchLanguage')}
            role="combobox"
            aria-expanded="true"
            aria-controls="settings-language-list"
            aria-activedescendant={filtered[active] ? `settings-language-${filtered[active].code}` : undefined}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div id="settings-language-list" role="listbox" className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {t('settings.noLanguages')}
            </p>
          ) : (
            filtered.map((language, index) => (
              <button
                key={language.code}
                id={`settings-language-${language.code}`}
                type="button"
                role="option"
                aria-selected={language.code === locale}
                onMouseEnter={() => setActive(index)}
                onClick={() => selectLocale(language.code)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
                  language.code === locale ? 'bg-accent/50' : index === active ? 'bg-muted' : ''
                }`}
              >
                <Check className={`size-4 shrink-0 ${language.code === locale ? 'opacity-100' : 'opacity-0'}`} />
                <span className="min-w-0 flex-1 truncate">{language.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {language.code}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const themeIcons = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} satisfies Record<Theme, typeof Monitor>

type CompressionMode = 'off' | 'lossless' | 'standard' | 'aggressive'

interface CompressionEngineConfig {
  enabled: boolean
  [key: string]: unknown
}

interface CompressionConfig {
  mode: CompressionMode
  engines: Record<string, CompressionEngineConfig>
  autoTriggerEstTokens?: number | null
  targetTokens?: number | null
  trustProjectFilters: boolean
  prefixFreeze: boolean
}

interface CompressionStats {
  requests: number
  compressedRequests: number
  estSavedTokens: number
  savingsPercent: number
}

// Engine ids as registered on the server (server/src/services/compression/engines),
// in pipeline priority order. `lossless` mirrors each engine's own flag so the
// badge can't drift from what the pipeline actually guarantees.
const ENGINES = [
  { id: 'dedup', tKey: 'engineDedup', lossless: true },
  { id: 'lite', tKey: 'engineLite', lossless: true },
  { id: 'read-lifecycle', tKey: 'engineReadLifecycle', lossless: false },
  { id: 'toolfilter', tKey: 'engineToolfilter', lossless: false },
  { id: 'jsoncompact', tKey: 'engineJsoncompact', lossless: true },
  { id: 'relevance', tKey: 'engineRelevance', lossless: false },
  { id: 'aging', tKey: 'engineAging', lossless: false },
  { id: 'hard-budget', tKey: 'engineHardBudget', lossless: false },
] as const

type SectionId = 'general' | 'compression' | 'advanced' | 'preview'

const SECTIONS = [
  { id: 'general', tKey: 'sectionGeneral', icon: SlidersHorizontal },
  { id: 'compression', tKey: 'sectionCompression', icon: Gauge },
  { id: 'advanced', tKey: 'sectionAdvanced', icon: Wrench },
  { id: 'preview', tKey: 'sectionPreview', icon: FlaskConical },
] as const satisfies ReadonlyArray<{ id: SectionId; tKey: string; icon: typeof Gauge }>

type CompressionState = ReturnType<typeof useCompressionSettings>

// Compression config/stats are loaded once per dialog opening and shared by the
// Compression, Advanced and Preview sections, so switching sections never
// refetches or discards pending edits.
function useCompressionSettings(open: boolean) {
  const { t } = useI18n()
  const [config, setConfig] = useState<CompressionConfig | null>(null)
  const [stats, setStats] = useState<CompressionStats | null>(null)
  const [busy, setBusy] = useState<'load' | 'save' | 'preview' | null>('load')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.all([
      apiFetch<CompressionConfig>('/api/settings/compression'),
      apiFetch<CompressionStats>('/api/compression/stats'),
    ]).then(([nextConfig, nextStats]) => {
      if (cancelled) return
      setConfig(nextConfig)
      setStats(nextStats)
      setError('')
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : t('common.unknownError'))
    }).finally(() => {
      if (!cancelled) setBusy(null)
    })
    return () => { cancelled = true }
  }, [open, t])

  const patch = useCallback((update: Partial<CompressionConfig>) => {
    setConfig(current => current ? { ...current, ...update } : current)
  }, [])

  const setEngineEnabled = useCallback((id: string, enabled: boolean) => {
    setConfig(current => current ? {
      ...current,
      engines: { ...current.engines, [id]: { ...(current.engines[id] ?? {}), enabled } },
    } : current)
  }, [])

  const save = useCallback(async () => {
    if (!config) return
    setBusy('save')
    setError('')
    try {
      setConfig(await apiFetch<CompressionConfig>('/api/settings/compression', {
        method: 'PUT',
        body: JSON.stringify(config),
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.unknownError'))
    } finally {
      setBusy(null)
    }
  }, [config, t])

  return { config, stats, busy, setBusy, error, setError, patch, setEngineEnabled, save }
}

function CompressionSection({ state }: { state: CompressionState }) {
  const { t } = useI18n()
  const { config, patch, setEngineEnabled } = state
  if (!config) return null

  const modes: Array<{ value: CompressionMode; label: string }> = [
    { value: 'off', label: t('settings.compressionOff') },
    { value: 'lossless', label: t('settings.compressionLossless') },
    { value: 'standard', label: t('settings.compressionStandard') },
    { value: 'aggressive', label: t('settings.compressionAggressive') },
  ]

  return (
    <>
      <SectionHeader
        title={t('settings.compressionTitle')}
        description={t('settings.compressionDescription')}
        hint={t('settings.compressionHelp')}
      />
      <Row label={t('settings.compressionMode')} hint={t('settings.compressionModeHelp')}>
        <OptionBar
          value={config.mode}
          onValueChange={mode => patch({ mode })}
          options={modes}
          ariaLabel={t('settings.compressionMode')}
          className="grid-cols-2 sm:grid-cols-4"
        />
      </Row>
      <Row label={t('settings.compressionEngines')} hint={t('settings.compressionEnginesHelp')}>
        <ul className="grid gap-2 sm:grid-cols-2">
          {ENGINES.map(engine => (
            <li
              key={engine.id}
              className="flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium">{t(`settings.${engine.tKey}`)}</span>
                  <InfoHint text={t(`settings.${engine.tKey}Help`)} />
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="font-mono">{engine.id}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {engine.lossless ? t('settings.compressionLossless') : t('settings.compressionLossy')}
                  </span>
                </div>
              </div>
              <Switch
                size="sm"
                aria-label={t(`settings.${engine.tKey}`)}
                checked={config.engines[engine.id]?.enabled ?? true}
                onCheckedChange={checked => setEngineEnabled(engine.id, checked)}
                className="mt-0.5"
              />
            </li>
          ))}
        </ul>
      </Row>
    </>
  )
}

function AdvancedSection({ state }: { state: CompressionState }) {
  const { t } = useI18n()
  const { config, patch } = state
  if (!config) return null

  return (
    <>
      <SectionHeader title={t('settings.sectionAdvanced')} description={t('settings.advancedDescription')} />
      <Row
        label={t('settings.compressionAutoTrigger')}
        hint={t('settings.compressionAutoTriggerHelp')}
        control={(
          <input
            type="number"
            min={1}
            value={config.autoTriggerEstTokens ?? ''}
            onChange={event => patch({
              autoTriggerEstTokens: event.target.value ? Number(event.target.value) : null,
            })}
            placeholder="32000"
            aria-label={t('settings.compressionAutoTrigger')}
            className="h-9 w-32 rounded-lg border border-input bg-transparent px-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        )}
      />
      <Row
        label={t('settings.compressionPrefixFreeze')}
        hint={t('settings.compressionPrefixFreezeHelp')}
        control={(
          <Switch
            aria-label={t('settings.compressionPrefixFreeze')}
            checked={config.prefixFreeze}
            onCheckedChange={prefixFreeze => patch({ prefixFreeze })}
          />
        )}
      />
      <Row
        label={t('settings.compressionTrustProjectFilters')}
        hint={t('settings.compressionTrustProjectFiltersHelp')}
        control={(
          <Switch
            aria-label={t('settings.compressionTrustProjectFilters')}
            checked={config.trustProjectFilters}
            onCheckedChange={trustProjectFilters => patch({ trustProjectFilters })}
          />
        )}
      />
    </>
  )
}

function PreviewSection({ state }: { state: CompressionState }) {
  const { t } = useI18n()
  const { config, stats, busy, setBusy, setError } = state
  const [previewInput, setPreviewInput] = useState('')
  const [previewOutput, setPreviewOutput] = useState('')

  async function preview() {
    if (!config || !previewInput.trim()) return
    setBusy('preview')
    setError('')
    try {
      let requestBody: unknown = previewInput
      try { requestBody = JSON.parse(previewInput) } catch { /* plain text preview */ }
      const result = await apiFetch<{
        compressed: unknown
        stats: { estSavedTokens: number }
      }>('/api/compression/preview', {
        method: 'POST',
        body: JSON.stringify({
          mode: config.mode,
          ...(requestBody && typeof requestBody === 'object' && 'messages' in requestBody
            ? requestBody as Record<string, unknown>
            : { body: previewInput }),
        }),
      })
      setPreviewOutput(`${JSON.stringify(result.compressed, null, 2)}\n\n~${result.stats.estSavedTokens} tokens saved`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.unknownError'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SectionHeader
        title={t('settings.compressionPreview')}
        description={t('settings.compressionPreviewDescription')}
      />
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <textarea
            value={previewInput}
            onChange={event => setPreviewInput(event.target.value)}
            placeholder={t('settings.compressionPreviewPlaceholder')}
            aria-label={t('settings.compressionPreview')}
            className="min-h-32 resize-y rounded-xl border border-input bg-transparent p-3 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
          <pre className="max-h-52 min-h-32 overflow-auto rounded-xl border bg-muted/30 p-3 text-[11px] whitespace-pre-wrap text-muted-foreground">
            {previewOutput}
          </pre>
        </div>
        <button
          type="button"
          onClick={preview}
          disabled={!previewInput.trim() || busy !== null}
          className="rounded-lg border px-3 py-1.5 text-xs transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {busy === 'preview' ? t('common.applying') : t('settings.compressionRunPreview')}
        </button>
      </div>

      {stats && (
        <dl className="mt-6 grid grid-cols-3 divide-x rounded-xl border py-3 text-center">
          <div>
            <dd className="text-base font-semibold">{stats.requests}</dd>
            <dt className="text-[10px] text-muted-foreground">{t('analytics.requests')}</dt>
          </div>
          <div>
            <dd className="text-base font-semibold">~{stats.estSavedTokens}</dd>
            <dt className="text-[10px] text-muted-foreground">{t('settings.compressionEstimatedTokensSaved')}</dt>
          </div>
          <div>
            <dd className="text-base font-semibold">{stats.savingsPercent}%</dd>
            <dt className="text-[10px] text-muted-foreground">{t('settings.compressionStats')}</dt>
          </div>
        </dl>
      )}
    </>
  )
}

const RELEASES_URL = 'https://github.com/tashfeenahmed/freellmapi/releases'

function GeneralSection({ active }: { active: boolean }) {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()

  return (
    <>
      <SectionHeader title={t('settings.sectionGeneral')} description={t('settings.generalDescription')} />
      <Row label={t('settings.language')} control={<LanguageCombobox />} />
      <Row
        label={t('settings.theme')}
        control={(
          <OptionBar
            value={theme}
            onValueChange={setTheme}
            options={([
              { value: 'system', label: t('settings.themeSystem') },
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
            ] satisfies Array<{ value: Theme; label: string }>).map(option => ({
              ...option,
              icon: themeIcons[option.value],
            }))}
            ariaLabel={t('settings.theme')}
            className="w-full grid-cols-3 sm:w-64"
          />
        )}
      />
      <UpdateChecker active={active} />
    </>
  )
}

type UpdateStatus = 'idle' | 'current' | 'available' | 'ahead' | 'diverged' | 'unknown' | 'unsupported' | 'disabled'
type CheckedUpdateStatus = Exclude<UpdateStatus, 'idle'>
type Installation = 'source' | 'docker' | 'desktop' | 'unknown'

interface UpdateStatusInfo {
  status: UpdateStatus
  installation: Installation
  localSha: string | null
  lastChecked: string | null
  /** The release this build is, or null when it cannot be established honestly. */
  version: string | null
}

interface UpdateCheckInfo {
  status: CheckedUpdateStatus
  installation: Installation
  localSha: string | null
  checkedAt: string
  version: string | null
  remoteSha?: string
  remoteDate?: string
  remoteMessage?: string
  changes?: Array<{
    sha: string
    message: string
    date?: string
  }>
}

function formatDateTime(value: string | null | undefined, locale: Locale) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return null
  }
}

/**
 * The one update surface in the dashboard: which build this is, and — on demand —
 * whether official `main` has moved past it (#491).
 *
 * The collapsed row is deliberately wordless, as the version row it replaces was
 * (#703): a proper noun, a version number, an arrow and icons, so it reads the
 * same in all 60 shipped locales. Words only appear behind the button, in the
 * dialog, where the commits and the deployment-specific upgrade command are —
 * and those strings are translated.
 *
 * Comparison happens on the server, against the local commit rather than a
 * release tag, so a source or container install that tracks `main` gets a true
 * answer instead of one that depends on tagging discipline. Nothing is fetched
 * until the button is clicked: a dashboard that phoned GitHub on open would make
 * an outbound request on behalf of an operator who never asked for one.
 */
function UpdateChecker({ active }: { active: boolean }) {
  const { locale, t } = useI18n()
  // The desktop shell knows its own version outright; browser and container
  // installs ask the server, which resolves it from the release manifest.
  const shellVersion = typeof window !== 'undefined'
    ? (window as { __FREEAPI_VERSION__?: string | null }).__FREEAPI_VERSION__ ?? null
    : null
  const [statusInfo, setStatusInfo] = useState<UpdateStatusInfo | null>(null)
  const [checkResult, setCheckResult] = useState<UpdateCheckInfo | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [activity, setActivity] = useState<string[]>([])
  // Opt-in for the automatic reminder pill (#782). `null` until the server has
  // answered, so the row never renders a state that isn't the stored one.
  const [autoCheck, setAutoCheck] = useState<boolean | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    apiFetch<{ enabled: boolean }>('/api/settings/update-check')
      .then(result => {
        if (!cancelled) setAutoCheck(result.enabled)
      })
      .catch(() => { /* leave the row out rather than claim a state */ })
    return () => { cancelled = true }
  }, [active])

  async function toggleAutoCheck(enabled: boolean) {
    const previous = autoCheck
    setAutoCheck(enabled)
    try {
      const result = await apiFetch<{ enabled: boolean }>('/api/settings/update-check', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      })
      setAutoCheck(result.enabled)
      // The reminder is mounted outside this dialog; tell it to re-check now
      // instead of leaving a stale pill (or no pill) until the next reload.
      window.dispatchEvent(new Event(UPDATE_CHECK_CHANGED_EVENT))
    } catch {
      setAutoCheck(previous)
    }
  }

  useEffect(() => {
    if (!active) return
    let cancelled = false
    apiFetch<UpdateStatusInfo>('/api/update/status')
      .then(result => {
        if (!cancelled) setStatusInfo(result)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        if (!cancelled) setLoadingStatus(false)
      })
    return () => { cancelled = true }
  }, [active])

  async function check() {
    setChecking(true)
    setError(false)
    setCheckResult(null)
    setActivity([
      statusInfo?.localSha
        ? `${t('settings.currentVersion')} ${statusInfo.localSha}`
        : t('settings.notGitInstall'),
      t('keys.checking'),
    ])
    try {
      const result = await apiFetch<UpdateCheckInfo>('/api/update/check')
      setCheckResult(result)
      setStatusInfo({
        status: result.status,
        installation: result.installation,
        localSha: result.localSha,
        lastChecked: result.checkedAt,
        version: result.version,
      })
      const resultMessage = result.status === 'available'
        ? t('settings.updateAvailable')
        : result.status === 'current'
          ? t('settings.upToDate')
          : result.status === 'ahead'
            ? t('settings.buildAhead')
            : result.status === 'diverged'
              ? t('settings.buildDiverged')
              : result.status === 'unknown'
                ? t('settings.buildUnknown')
                : t('settings.notGitInstall')
      setActivity(current => [current[0], resultMessage])
    } catch {
      setError(true)
      setActivity(current => current.slice(0, 1))
    } finally {
      setChecking(false)
    }
  }

  function openChecker() {
    setDialogOpen(true)
    void check()
  }

  const info = checkResult
  const currentSha = info?.localSha ?? statusInfo?.localSha
  const version = shellVersion ?? info?.version ?? statusInfo?.version ?? null
  const lastChecked = formatDateTime(checkResult?.checkedAt, locale)
  const remoteDate = formatDateTime(checkResult?.remoteDate, locale)
  const statusMessage = info?.status === 'current'
    ? t('settings.upToDate')
    : info?.status === 'ahead'
      ? t('settings.buildAhead')
      : info?.status === 'diverged'
        ? t('settings.buildDiverged')
        : info?.status === 'unknown'
          ? t('settings.buildUnknown')
          : info?.status === 'unsupported'
            ? t('settings.notGitInstall')
            : null

  const status = info?.status ?? statusInfo?.status

  if ((loadingStatus && !statusInfo) || statusInfo?.status === 'disabled') return null
  // Neither a release version nor a commit to compare: say nothing rather than
  // render a row that can only fail.
  if (!version && !currentSha) return null

  return (
    <>
      <Row
        label="FreeLLMAPI"
        hint={t('settings.contactsGithub')}
        control={(
          <div className="flex items-center gap-2 text-sm tabular-nums">
            {version
              ? <span>v{version}</span>
              : <code className="font-mono text-xs">{currentSha}</code>}
            {status === 'available' && (
              <button
                type="button"
                onClick={openChecker}
                title={t('settings.updateAvailable')}
                className="flex items-center gap-1 text-primary underline underline-offset-2"
              >
                <ArrowRight className="size-3.5" aria-hidden />
                <span className={info?.remoteSha ? 'font-mono' : undefined}>
                  {info?.remoteSha ?? t('settings.updateAvailable')}
                </span>
              </button>
            )}
            {status === 'current' && <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />}
            {error && (
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer noopener"
                title={RELEASES_URL}
                className="text-primary underline underline-offset-2"
              >
                {RELEASES_URL.replace('https://', '')}
              </a>
            )}
            <button
              type="button"
              onClick={openChecker}
              disabled={loadingStatus || checking}
              title={t('settings.checkForUpdates')}
              aria-label={t('settings.checkForUpdates')}
              className="inline-flex rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden />
            </button>
          </div>
        )}
      />

      {autoCheck !== null && (
        <Row
          label={t('settings.autoUpdateCheck')}
          hint={t('settings.autoUpdateCheckHelp')}
          control={(
            <Switch
              aria-label={t('settings.autoUpdateCheck')}
              checked={autoCheck}
              onCheckedChange={checked => void toggleAutoCheck(checked)}
            />
          )}
        />
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup maxWidth="max-w-xl" className="p-0">
          <div className="flex items-start justify-between gap-4 border-b px-6 py-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <RefreshCw className={`size-4 ${checking ? 'animate-spin' : ''}`} />
              </div>
              <div className="min-w-0">
                <DialogTitle>{t('settings.updatesTitle')}</DialogTitle>
                {(version || currentSha) && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {t('settings.currentVersion')}{' '}
                    <code className="font-mono">
                      {[version ? `v${version}` : null, currentSha].filter(Boolean).join(' · ')}
                    </code>
                  </p>
                )}
              </div>
            </div>
            <DialogClose
              aria-label={t('common.dismiss')}
              className="-me-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X className="size-4" />
            </DialogClose>
          </div>

          <div aria-live="polite" className="space-y-4 px-6 py-5">
            {activity.length > 0 && (
              <div className="overflow-hidden rounded-xl border bg-zinc-950 text-zinc-300 shadow-inner dark:bg-black/40">
                <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-[11px] text-zinc-400">
                  <SquareTerminal className="size-3.5" />
                  <span>{checking ? t('keys.checking') : t('settings.updatesTitle')}</span>
                </div>
                <div className="space-y-1.5 px-3 py-3 font-mono text-[11px] leading-relaxed">
                  {activity.map((entry, index) => (
                    <p key={`${index}-${entry}`} className="flex gap-2 break-words [overflow-wrap:anywhere]">
                      <span className={index === activity.length - 1 && checking ? 'text-amber-400' : 'text-emerald-400'}>&gt;</span>
                      <span>{entry}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}

            {info?.status === 'available' && (
              <div className="space-y-4">
                <div className="flex gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
                  <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{t('settings.updateAvailable')}</p>
                    {info.remoteMessage && (
                      <p className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{info.remoteMessage}</p>
                    )}
                    {(info.remoteSha || remoteDate) && (
                      <p className="break-all font-mono text-[11px] text-muted-foreground">
                        {[info.remoteSha, remoteDate].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                </div>

                {info.changes && info.changes.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <Check className="size-3.5" />
                      {t('settings.changelog')}
                    </h3>
                    <ol className="max-h-52 divide-y overflow-y-auto rounded-xl border">
                      {info.changes.map(change => {
                        const changeDate = formatDateTime(change.date, locale)
                        return (
                          <li key={change.sha} className="flex gap-3 px-3 py-2.5">
                            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                            <div className="min-w-0">
                              <p className="break-words text-xs [overflow-wrap:anywhere]">{change.message}</p>
                              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                                {[change.sha, changeDate].filter(Boolean).join(' · ')}
                              </p>
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  </div>
                )}

                {info.installation === 'docker' && (
                  <div className="flex gap-2 rounded-xl border bg-muted/30 p-3">
                    <SquareTerminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <code className="whitespace-pre-wrap break-all font-mono text-[11px]">docker compose pull && docker compose up -d</code>
                  </div>
                )}
                {info.installation === 'source' && (
                  <div className="space-y-2">
                    <div className="flex gap-2 rounded-xl border bg-muted/30 p-3">
                      <SquareTerminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <code className="whitespace-pre-wrap break-all font-mono text-[11px]">git fetch https://github.com/tashfeenahmed/freellmapi.git main && git merge --ff-only FETCH_HEAD && npm ci && npm run build</code>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{t('settings.restartAfterUpdate')}</p>
                  </div>
                )}
                {(info.installation === 'desktop' || info.installation === 'unknown') && (
                  <a
                    href="https://github.com/tashfeenahmed/freellmapi/releases/latest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-4"
                  >
                    {t('settings.openReleases')}
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            )}

            {statusMessage && (
              <div className={`flex gap-3 rounded-xl border p-4 ${info?.status === 'current' ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-amber-500/25 bg-amber-500/5'}`}>
                {info?.status === 'current'
                  ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" />
                  : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />}
                <p className="text-sm">{statusMessage}</p>
              </div>
            )}

            {error && (
              <div role="alert" className="flex gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
                <p className="text-sm text-destructive">{t('settings.checkFailed')}</p>
              </div>
            )}

            <div className="flex flex-col-reverse items-stretch justify-between gap-3 border-t pt-4 sm:flex-row sm:items-center">
              <div className="space-y-0.5">
                {lastChecked && <p className="text-[11px] text-muted-foreground">{t('settings.lastChecked', { when: lastChecked })}</p>}
              </div>
              <button
                type="button"
                onClick={() => void check()}
                disabled={checking}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className={`size-3.5 ${checking ? 'animate-spin' : ''}`} />
                {checking ? t('keys.checking') : t('settings.checkForUpdates')}
              </button>
            </div>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const [section, setSection] = useState<SectionId>('general')
  const state = useCompressionSettings(open)
  const { config, busy, error, save } = state
  const compressionSection = section !== 'general'
  const loading = compressionSection && !config && busy === 'load'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-3xl" className="flex flex-col overflow-y-hidden p-0">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-4 sm:px-6">
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-me-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Sidebar on ≥sm, scrollable tab strip below it — the same
              breakpoint-swap the navbar uses for its own navigation. */}
          <nav
            aria-label={t('settings.sections')}
            className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-e sm:p-3"
          >
            {SECTIONS.map(item => {
              const Icon = item.icon
              const selected = section === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => setSection(item.id)}
                  className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-start text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:text-sm ${
                    selected
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{t(`settings.${item.tKey}`)}</span>
                </button>
              )
            })}
          </nav>

          {/* min-height keeps the popup from resizing as sections are switched. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:min-h-[27rem] sm:px-6 sm:py-6">
            {section === 'general' && <GeneralSection active={open} />}
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('common.loading')}
              </div>
            )}
            {compressionSection && config && (
              <>
                {section === 'compression' && <CompressionSection state={state} />}
                {section === 'advanced' && <AdvancedSection state={state} />}
                {section === 'preview' && <PreviewSection state={state} />}
              </>
            )}
            {compressionSection && !config && !loading && error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
          </div>
        </div>

        {compressionSection && config && (
          <div className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3 sm:px-6">
            {error && <p className="me-auto text-xs text-destructive">{error}</p>}
            <button
              type="button"
              onClick={save}
              disabled={busy !== null}
              className="rounded-lg bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {busy === 'save' ? t('common.saving') : t('common.saveChanges')}
            </button>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  )
}
