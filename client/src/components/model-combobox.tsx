import { useState, type ReactNode } from 'react'
import { ChevronsUpDown, Check, Search } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Tooltip } from '@/components/tooltip'
import { useI18n } from '@/i18n'

// Searchable model picker, extracted from the Playground so every model
// selection in the dashboard can use the same control. Substring match over
// name, provider names, and id; arrow keys + Enter select.
export interface ModelComboOption {
  value: string
  label: string
  /** Right-aligned hint: provider name or "N providers". */
  sub?: string
  isNew?: boolean
  /** Provider names when the model is served by several (hover + search). */
  platforms?: string[]
}

export function ModelCombobox({
  value,
  options,
  onSelect,
  ariaLabel,
  placeholder,
  emptyText,
  footer,
  align = 'end',
  triggerClassName,
}: {
  value: string
  options: ModelComboOption[]
  onSelect: (value: string) => void
  ariaLabel: string
  placeholder: string
  emptyText: string
  /** Optional hint row under the list (e.g. "add a key to see models"). */
  footer?: ReactNode
  align?: 'start' | 'center' | 'end'
  triggerClassName?: string
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const q = query.trim().toLowerCase()
  const filtered = q
    ? options.filter(o => `${o.label} ${o.sub ?? ''} ${o.value} ${(o.platforms ?? []).join(' ')}`.toLowerCase().includes(q))
    : options
  const triggerLabel = options.find(o => o.value === value)?.label ?? value

  function pick(v: string) {
    onSelect(v)
    setOpen(false)
    setQuery('')
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(a => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(a => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && filtered[active]) {
      e.preventDefault()
      pick(filtered[active].value)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={o => {
        setOpen(o)
        if (!o) setQuery('')
        else setActive(0)
      }}
    >
      <PopoverTrigger
        aria-label={ariaLabel}
        className={
          triggerClassName ??
          'flex h-8 w-[260px] items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30'
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[300px] p-0" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setActive(0)
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">{emptyText}</div>
          ) : (
            filtered.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
                  o.value === value ? 'bg-accent/50' : i === active ? 'bg-muted' : ''
                }`}
              >
                <Check className={`size-4 shrink-0 ${o.value === value ? 'opacity-100' : 'opacity-0'}`} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.isNew && (
                  <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    {t('models.newBadge')}
                  </span>
                )}
                {o.sub && ((o.platforms?.length ?? 0) > 1 ? (
                  <Tooltip text={t('models.servedBy', { providers: (o.platforms ?? []).join(', ') })}>
                    <span className="shrink-0 text-xs text-muted-foreground underline decoration-dotted underline-offset-2">{o.sub}</span>
                  </Tooltip>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">{o.sub}</span>
                ))}
              </button>
            ))
          )}
          {footer}
        </div>
      </PopoverContent>
    </Popover>
  )
}
