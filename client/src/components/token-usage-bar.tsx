import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useI18n } from '@/i18n'
import { formatPercent, formatTokens, platformColors, type TokenUsageData } from '@/lib/routing'

// Legend rows visible while collapsed (~6 rows: 6 × 16px line + 5 × 6px gap).
const LEGEND_COLLAPSED_PX = 126

// Stacked monthly token-budget bar with a collapsible per-model legend,
// extracted from FallbackPage.
export function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { t } = useI18n()
  const { totalBudget, totalUsed, models, oneTimeModels = [] } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? formatPercent(remaining / totalBudget) : '0%'

  // Collapse the per-model legend to a few rows; the chevron reveals the rest.
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const legendRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = legendRef.current
    if (!el) return
    const check = () => setCollapsible(el.scrollHeight > LEGEND_COLLAPSED_PX + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [models.length])

  // One-time grants collapse/expand
  const [oneTimeExpanded, setOneTimeExpanded] = useState(false)
  const [oneTimeCollapsible, setOneTimeCollapsible] = useState(false)
  const oneTimeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = oneTimeRef.current
    if (!el) return
    const check = () => setOneTimeCollapsible(el.scrollHeight > LEGEND_COLLAPSED_PX + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [oneTimeModels.length])

  const modelsWithWidth = models.map(m => {
    const usedTokens = m.used ?? 0
    const remainingTokens = Math.max(0, m.budget - usedTokens)
    return {
      ...m,
      usedTokens,
      remainingTokens,
      widthPct: totalBudget > 0 ? (remainingTokens / totalBudget) * 100 : 0,
    }
  })
  const usedPct = totalBudget > 0 ? Math.min(100, (totalUsed / totalBudget) * 100) : 0

  const oneTimeWithCalc = oneTimeModels.map(m => {
    const usedTokens = m.used ?? 0
    const remainingTokens = Math.max(0, m.budget - usedTokens)
    return { ...m, usedTokens, remainingTokens }
  })
  const oneTimeTotalBudget = oneTimeWithCalc.reduce((s, m) => s + m.budget, 0)
  const oneTimeTotalUsed = oneTimeWithCalc.reduce((s, m) => s + m.usedTokens, 0)
  const oneTimeRemaining = Math.max(0, oneTimeTotalBudget - oneTimeTotalUsed)

  return (
    <>
      {/* ── Monthly rolling budget ────────────────────────────────────────── */}
      {totalBudget > 0 && (
        <section className="rounded-3xl border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium">{t('models.monthlyTokenBudget')}</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              <span className="text-foreground font-medium">{formatTokens(remaining)}</span> {t('models.remaining')}
              <span className="mx-1.5">·</span>
              {remainingPct} {t('models.of')} {formatTokens(totalBudget)}
              {totalUsed > 0 && (
                <>
                  <span className="mx-1.5">·</span>
                  <span className="text-foreground font-medium">{formatTokens(totalUsed)}</span> {t('models.used')}
                </>
              )}
            </span>
          </div>

          <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
            {modelsWithWidth.map((m, i) => (
              <div
                key={i}
                title={`${m.displayName} (${m.platform}): ${formatTokens(m.remainingTokens)} ${t('models.remaining')}, ${formatTokens(m.usedTokens)} ${t('models.used')}`}
                style={{
                  width: `${m.widthPct}%`,
                  backgroundColor: platformColors[m.platform] ?? '#94a3b8',
                }}
              />
            ))}
            {totalUsed > 0 && (
              <div
                title={`Used: ${formatTokens(totalUsed)}`}
                className="bg-muted-foreground/30"
                style={{ width: `${usedPct}%` }}
              />
            )}
          </div>

          <div
            ref={legendRef}
            className="mt-4 overflow-hidden transition-[max-height] duration-300 ease-in-out"
            style={collapsible ? { maxHeight: expanded ? legendRef.current?.scrollHeight : LEGEND_COLLAPSED_PX } : undefined}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
              {modelsWithWidth.map((m, i) => (
                <div key={i} className="flex items-center gap-2 min-w-0">
                  <span
                    className="size-2 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
                  />
                  <span className="truncate">{m.displayName}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-muted-foreground">{formatTokens(m.remainingTokens)}</span>
                </div>
              ))}
            </div>
          </div>

          {collapsible && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {expanded ? t('models.showLess') : t('models.showAllModels', { count: models.length })}
              <ChevronDown className={`size-3.5 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </section>
      )}

      {/* ── One-time quota grants ─────────────────────────────────────────── */}
      {oneTimeWithCalc.length > 0 && (
        <section className="rounded-3xl border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium">One-time quota grants</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              <span className="text-foreground font-medium">{formatTokens(oneTimeRemaining)}</span> remaining
              <span className="mx-1.5">·</span>
              {formatTokens(oneTimeTotalBudget)} total
              {oneTimeTotalUsed > 0 && (
                <>
                  <span className="mx-1.5">·</span>
                  <span className="text-foreground font-medium">{formatTokens(oneTimeTotalUsed)}</span> used
                </>
              )}
              <span className="mx-1.5">·</span>
              <span className="text-muted-foreground">{oneTimeWithCalc.length} models</span>
            </span>
          </div>

          {/* Progress bar showing total remaining vs used */}
          <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
            {oneTimeWithCalc.map((m, i) => (
              <div
                key={i}
                title={`${m.displayName} (${m.platform}): ${formatTokens(m.remainingTokens)} remaining, ${formatTokens(m.usedTokens)} used`}
                style={{
                  width: oneTimeTotalBudget > 0 ? `${(m.remainingTokens / oneTimeTotalBudget) * 100}%` : '0%',
                  backgroundColor: platformColors[m.platform] ?? '#94a3b8',
                }}
              />
            ))}
            {oneTimeTotalUsed > 0 && (
              <div
                className="bg-muted-foreground/30"
                style={{ width: oneTimeTotalBudget > 0 ? `${(oneTimeTotalUsed / oneTimeTotalBudget) * 100}%` : '0%' }}
              />
            )}
          </div>

          <div
            ref={oneTimeRef}
            className="mt-4 overflow-hidden transition-[max-height] duration-300 ease-in-out"
            style={oneTimeCollapsible ? { maxHeight: oneTimeExpanded ? oneTimeRef.current?.scrollHeight : LEGEND_COLLAPSED_PX } : undefined}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
              {oneTimeWithCalc.map((m, i) => (
                <div key={i} className="flex items-center gap-2 min-w-0">
                  <span
                    className="size-2 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
                  />
                  <span className="truncate">{m.displayName}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-muted-foreground">{formatTokens(m.remainingTokens)}</span>
                </div>
              ))}
            </div>
          </div>

          {oneTimeCollapsible && (
            <button
              onClick={() => setOneTimeExpanded(e => !e)}
              className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {oneTimeExpanded ? t('models.showLess') : t('models.showAllModels', { count: oneTimeWithCalc.length })}
              <ChevronDown className={`size-3.5 transition-transform duration-300 ${oneTimeExpanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </section>
      )}
    </>
  )
}
