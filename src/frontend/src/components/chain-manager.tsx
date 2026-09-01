import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Layers, Plus, Trash2 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch, type ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tooltip } from '@/components/tooltip'

// Named fallback chains (#960/#895). The backend /api/profiles CRUD is
// complete and every chain is listed as an `auto:<name>` model in /v1/models;
// this panel is the missing dashboard surface: list chains, create new ones,
// switch the active chain (the fallback table below then edits that chain),
// and delete custom ones.
//
// Deliberately a secondary, collapsed-by-default accordion on the Fallback
// page rather than its own nav entry: most installs use one chain forever, and
// the routing table below is what the page is for.

const COLLAPSED_KEY = 'freellmapi.chainManager.collapsed'

function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY)
    return stored === null ? true : stored === '1'
  } catch {
    return true
  }
}

export interface Chain {
  id: number
  name: string
  emoji: string
  color: string
  type: 'default' | 'builtin' | 'custom'
  is_favorite: number
  sort_order: number
  auto_sort: string | null
  layout_config: string | null
  // 0 once the chain opts out of the catalog-sync backfill (#895), which is
  // what an empty-created chain does — it stays exactly as hand-built.
  auto_include_new_models: number
  created_at: string
}

export function ChainManager() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [newName, setNewName] = useState('')
  const [startEmpty, setStartEmpty] = useState(true)
  const [createError, setCreateError] = useState('')
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)

  const { data: chains = [] } = useQuery<Chain[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
  })
  const { data: active } = useQuery<{ activeProfileId: number | null }>({
    queryKey: ['profiles', 'active'],
    queryFn: () => apiFetch('/api/profiles/active'),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['profiles'] })
    queryClient.invalidateQueries({ queryKey: ['profiles', 'active'] })
    // The fallback table renders the active chain; refresh it too.
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
    queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
  }

  const createChain = useMutation({
    mutationFn: (payload: { name: string; empty: boolean }) =>
      apiFetch('/api/profiles', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      invalidate()
      setNewName('')
      setCreateError('')
    },
    // Names are validated server-side (max 20 chars, Latin/digits/-/_ only, a
    // list of reserved words, no duplicates). Say which rule was broken rather
    // than swallowing the 400/409.
    onError: (error: ApiError) => setCreateError(error.message || t('chains.createFailed')),
  })
  const setActive = useMutation({
    mutationFn: (profileId: number) =>
      apiFetch('/api/profiles/active', { method: 'POST', body: JSON.stringify({ profileId }) }),
    onSuccess: invalidate,
  })
  const deleteChain = useMutation({
    mutationFn: (profileId: number) =>
      apiFetch(`/api/profiles/${profileId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  if (chains.length === 0) return null

  const activeId = active?.activeProfileId ?? null

  function toggle() {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  return (
    <section className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('common.show') : t('common.hide')}
        className={`flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left ${collapsed ? '' : 'border-b'}`}
      >
        <div className="flex items-center gap-2">
          <Layers className="size-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-medium">{t('chains.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('chains.description')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
            {t('chains.count', { count: chains.length })}
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </div>
      </button>

      {!collapsed && (
        <div className="p-4">
          <div className="space-y-2">
            {chains.map(chain => {
              const isActive = chain.id === activeId
              const isProtected = chain.type === 'default' || chain.type === 'builtin'
              return (
                <div
                  key={chain.id}
                  className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 ${
                    isActive ? 'border-foreground/25 bg-muted/50' : 'border-transparent hover:bg-muted/40'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium" title={chain.name}>
                    {chain.emoji || <Layers className="size-3.5 text-muted-foreground" />}
                    <span className="truncate">{chain.name}</span>
                  </span>
                  {/* The id a client sends to pick this chain per request. */}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    auto:{chain.name.toLowerCase()}
                  </code>
                  {isActive && (
                    <Badge variant="secondary" className="gap-1">
                      <Check className="size-3" />
                      {t('chains.active')}
                    </Badge>
                  )}
                  {isProtected && !isActive && (
                    <span className="text-[11px] text-muted-foreground">{t('chains.default')}</span>
                  )}
                  {chain.auto_include_new_models === 0 && (
                    <Tooltip text={t('chains.curatedHint')}>
                      <span className="cursor-help text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2">
                        {t('chains.curated')}
                      </span>
                    </Tooltip>
                  )}
                  <span className="flex-1" />
                  {!isActive && (
                    <Tooltip text={t('chains.activateHint')}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={setActive.isPending}
                        onClick={() => setActive.mutate(chain.id)}
                      >
                        {t('chains.activate')}
                      </Button>
                    </Tooltip>
                  )}
                  {!isProtected && (
                    <Tooltip text={t('chains.deleteHint')}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-rose-600"
                        aria-label={t('chains.deleteHint')}
                        disabled={deleteChain.isPending}
                        onClick={() => {
                          if (window.confirm(t('chains.deleteConfirm', { name: chain.name }))) {
                            deleteChain.mutate(chain.id)
                          }
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </Tooltip>
                  )}
                </div>
              )
            })}
          </div>

          <form
            className="mt-3 flex gap-2"
            onSubmit={e => {
              e.preventDefault()
              const name = newName.trim()
              if (name && !createChain.isPending) createChain.mutate({ name, empty: startEmpty })
            }}
          >
            <Input
              value={newName}
              onChange={e => {
                setNewName(e.target.value)
                setCreateError('')
              }}
              placeholder={t('chains.createPlaceholder')}
              aria-label={t('chains.createPlaceholder')}
              className="h-8"
            />
            <Button type="submit" size="sm" className="h-8" disabled={!newName.trim() || createChain.isPending}>
              <Plus className="size-3.5" />
              {t('chains.create')}
            </Button>
          </form>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={startEmpty}
              onChange={e => setStartEmpty(e.target.checked)}
              className="size-3.5 accent-foreground"
            />
            <span>{t('chains.startEmpty')}</span>
            <Tooltip text={t('chains.startEmptyHint')}>
              <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
            </Tooltip>
          </label>

          {createError
            ? <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">{createError}</p>
            : <p className="mt-1.5 text-xs text-muted-foreground">{t('chains.nameRules')}</p>}
        </div>
      )}
    </section>
  )
}
