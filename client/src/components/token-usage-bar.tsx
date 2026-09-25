import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useI18n } from '@/i18n'
import { buildBudgetLegend } from '@/lib/budget-legend'
import { formatPercent, formatTokens, platformColors, type TokenUsageData } from '@/lib/routing'

const LEGEND_COLLAPSED_PX = 126

// The monthly token budget: a stacked bar of every configured model's remaining
// allowance, and under it one flat legend of models, smartest first. No
// provider headers — the provider pool grouping (#1010) made the first thing on
// the Models page read as "arranged by provider"; pool quota readings live on
// each model's own page instead.
export function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { t } = useI18n()
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? formatPercent(remaining / totalBudget) : '0%'
  const usedPct = totalBudget > 0 ? Math.min(100, (totalUsed / totalBudget) * 100) : 0

  const { rows, unpublishedCount } = buildBudgetLegend(models, totalBudget)

  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  // The legend's full height, measured in the effect (refs are not read during
  // render) so the expanded max-height animates to the real size.
  const [fullHeight, setFullHeight] = useState<number>()
  const legendRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = legendRef.current
    if (!el) return
    const check = () => {
      setFullHeight(el.scrollHeight)
      setCollapsible(el.scrollHeight > LEGEND_COLLAPSED_PX + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rows.length, unpublishedCount])

  return (
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
              {/* Say out loud what this number counts (#887): it is not the
                  analytics total, and custom endpoints are in it. */}
              <span className="cursor-help underline decoration-dotted underline-offset-2" title={t('models.usedScopeHint')}>
                <span className="text-foreground font-medium">{formatTokens(totalUsed)}</span> {t('models.used')}
              </span>
            </>
          )}
        </span>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {rows.map(m => (
          <div
            key={`${m.platform}:${m.modelId ?? m.displayName}`}
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
        style={collapsible ? { maxHeight: expanded ? fullHeight : LEGEND_COLLAPSED_PX } : undefined}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
          {rows.map(m => (
            <div key={`${m.platform}:${m.modelId ?? m.displayName}`} className="flex items-center gap-2 min-w-0">
              <span
                className="size-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
              />
              <span className="truncate">{m.displayName}</span>
              <span className="flex-1" />
              {/* remaining / budget: a bare remaining figure gives no sense of
                  how much of the allowance is gone (#887). */}
              <span
                className="font-mono text-muted-foreground"
                title={t('models.legendRemainingTitle', { name: m.displayName, platform: m.platform })}
              >
                {formatTokens(m.remainingTokens)}<span className="mx-0.5">/</span>{formatTokens(m.budget)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Outside the collapsible box on purpose: it is a summary of what the
          legend is NOT showing, so it has to stay visible while collapsed. */}
      {unpublishedCount > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground" title={t('models.noPublishedQuotaTitle')}>
          {t('models.noPublishedQuota', { count: unpublishedCount })}
        </p>
      )}

      {collapsible && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? t('models.showLess') : t('models.showAllModels', { count: rows.length })}
          <ChevronDown className={`size-3.5 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </section>
  )
}
