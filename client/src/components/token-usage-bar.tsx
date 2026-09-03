import { Fragment, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { formatPercent, formatTokens, platformColors, type TokenUsageData } from '@/lib/routing'
import {
  buildLegendGroups,
  poolScopeWords,
  type FreeTierPool,
  type FreeTierResponse,
  type LegendGroup,
} from '@/lib/pool-legend'

// Legend rows visible while collapsed (~6 rows: 6 × 16px line + 5 × 6px gap).
const LEGEND_COLLAPSED_PX = 126

const METRIC_KEYS: Record<string, string> = {
  tokens: 'freeTier.metricTokens',
  requests: 'freeTier.metricRequests',
  credits: 'freeTier.metricCredits',
  neurons: 'freeTier.metricNeurons',
}

// Stacked monthly token-budget bar with a collapsible per-model legend,
// extracted from FallbackPage.
export function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { t } = useI18n()
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? formatPercent(remaining / totalBudget) : '0%'

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

  // Provider pools (#905): many models on one platform share a single free
  // allowance, so the legend groups its rows under the pool they draw from
  // rather than repeating the same numbers in a second table of its own.
  const { data: freeTier } = useQuery({
    queryKey: ['free-tier'],
    queryFn: () => apiFetch<FreeTierResponse>('/api/free-tier'),
  })

  // A model with no published monthly quota has nothing to say in a
  // remaining/budget legend, and one provider can contribute a hundred of them
  // (#887) — drowning the models that do have a budget. Count them instead.
  const { groups, unpublishedCount, rowCount } = buildLegendGroups(modelsWithWidth, freeTier?.pools)
  const hasPoolHeaders = groups.some(g => g.pool !== null)

  // Collapse the per-model legend to a few rows; the chevron reveals the rest.
  // The toggle only appears when the legend actually overflows the collapsed
  // height (column count — and so row count — depends on viewport width).
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
  }, [rowCount, groups.length, unpublishedCount])

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
          {groups.map(group => (
            <Fragment key={group.pool?.poolKey ?? 'independent'}>
              {group.pool ? (
                <PoolHeader pool={group.pool} />
              ) : (
                // Only worth naming once something else in the list IS a pool;
                // on its own it is just the flat legend.
                hasPoolHeaders && (
                  <div className="col-span-full text-muted-foreground pt-1.5 first:pt-0">
                    {t('freeTier.independentBudgets')}
                  </div>
                )
              )}
              {group.models.map((m, i) => (
                <div
                  key={`${m.platform}:${m.modelId ?? i}`}
                  className={`flex items-center gap-2 min-w-0 ${group.pool || hasPoolHeaders ? 'pl-4' : ''}`}
                >
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
            </Fragment>
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
          {expanded ? t('models.showLess') : t('models.showAllModels', { count: rowCount })}
          <ChevronDown className={`size-3.5 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </section>
  )
}

// One pool of models, headed by everything the separate pools table used to
// show: what the pool is, how many models sit in it, the documented allowance
// scaled by usable keys, and the live reading with its metric named.
function PoolHeader({ pool }: { pool: NonNullable<LegendGroup['pool']> }) {
  const { t } = useI18n()
  const scope = poolScopeWords(pool.poolKey)
  const label = scope
    ? t('freeTier.poolLabel', { platform: pool.platform, scope })
    : t('freeTier.poolLabelBare', { platform: pool.platform })

  return (
    <div className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1.5 first:pt-0">
      <span
        className="size-2 rounded-sm flex-shrink-0"
        style={{ backgroundColor: platformColors[pool.platform] ?? '#94a3b8' }}
      />
      <span className="font-medium truncate" title={pool.poolKey}>{label}</span>
      <span className="text-muted-foreground">
        {t('freeTier.poolModels', { count: pool.modelCount })}
        {pool.disabledModelCount > 0 && ` ${t('freeTier.disabledModels', { count: pool.disabledModelCount })}`}
      </span>
      <span className="flex-1" />
      <PoolQuota pool={pool} />
      {pool.documentedBudget > 0 ? (
        <span
          className="font-mono text-muted-foreground"
          title={t('freeTier.poolBudgetTitle', { count: Math.max(1, pool.keyCount) })}
        >
          {t('freeTier.poolBudget', { budget: formatTokens(pool.documentedBudget) })}
        </span>
      ) : (
        <span className="text-muted-foreground">
          {pool.kind === 'credits' ? t('freeTier.kindCredits') : t('freeTier.poolNoQuota')}
        </span>
      )}
    </div>
  )
}

// The live reading, with the metric spelled out: a request counter next to a
// token budget reads as tokens otherwise.
function PoolQuota({ pool }: { pool: FreeTierPool }) {
  const { t } = useI18n()
  if (!pool.quota || pool.quota.remaining == null) return null
  const metric = t(METRIC_KEYS[pool.quota.metric] ?? 'freeTier.metricOther')
  return (
    <span className="text-muted-foreground whitespace-nowrap">
      <span className="font-mono">{formatTokens(pool.quota.remaining)}</span> {metric} {t('models.remaining')}
      {pool.quota.resetAt && (
        <>
          <span className="mx-1.5">·</span>
          {t('freeTier.poolResets', { time: new Date(pool.quota.resetAt).toLocaleString() })}
        </>
      )}
    </span>
  )
}
