import { useQuery } from '@tanstack/react-query'
import { Coins, Layers, Database } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CardSkeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'

interface FreeTierQuota {
  limit: number | null
  remaining: number | null
  resetAt: string | null
  metric: string | null
}

interface FreeTierPool {
  poolKey: string
  platform: string
  modelCount: number
  documentedBudget: number
  bestLabel: string
  kind: 'documented' | 'credits' | 'unpublished'
  quota: FreeTierQuota | null
}

interface FreeTierResponse {
  generatedAt: string
  summary: {
    poolCount: number
    documentedMonthlyTokens: number
    creditsBasedPools: number
    unpublishedPools: number
  }
  pools: FreeTierPool[]
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

export default function FreeTierPage() {
  const { t } = useI18n()
  const { data, isLoading } = useQuery({
    queryKey: ['free-tier'],
    queryFn: () => apiFetch<FreeTierResponse>('/api/free-tier'),
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('freeTier.title')}
        description={t('freeTier.description')}
      />

      {isLoading || !data ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Coins className="h-4 w-4" />
                  {t('freeTier.documentedMonthly')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {fmtTokens(data.summary.documentedMonthlyTokens)}
                  <span className="text-sm font-normal text-muted-foreground ml-1">tokens/mo</span>
                </div>
                <CardDescription>{t('freeTier.documentedMonthlyHint')}</CardDescription>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Layers className="h-4 w-4" />
                  {t('freeTier.pools')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data.summary.poolCount}</div>
                <CardDescription>
                  {t('freeTier.creditsBased')}: {data.summary.creditsBasedPools} ·{' '}
                  {t('freeTier.unpublished')}: {data.summary.unpublishedPools}
                </CardDescription>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  {t('freeTier.generatedAt')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-lg font-bold">{new Date(data.generatedAt).toLocaleTimeString()}</div>
                <CardDescription>{t('freeTier.liveQuotaHint')}</CardDescription>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('freeTier.pool')}</TableHead>
                    <TableHead>{t('freeTier.platform')}</TableHead>
                    <TableHead className="text-right">{t('freeTier.models')}</TableHead>
                    <TableHead className="text-right">{t('freeTier.budget')}</TableHead>
                    <TableHead>{t('freeTier.kind')}</TableHead>
                    <TableHead className="text-right">{t('freeTier.remaining')}</TableHead>
                    <TableHead>{t('freeTier.resetAt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.pools.map(p => (
                    <TableRow key={p.poolKey}>
                      <TableCell className="font-medium">{p.poolKey}</TableCell>
                      <TableCell>{p.platform}</TableCell>
                      <TableCell className="text-right">{p.modelCount}</TableCell>
                      <TableCell className="text-right">{p.bestLabel || '—'}</TableCell>
                      <TableCell>
                        <Badge
                          variant={p.kind === 'documented' ? 'default' : p.kind === 'credits' ? 'secondary' : 'outline'}
                        >
                          {p.kind === 'documented' ? t('freeTier.kindDocumented') : p.kind === 'credits' ? t('freeTier.kindCredits') : t('freeTier.kindUnpublished')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {p.quota?.remaining != null ? fmtTokens(p.quota.remaining) : '—'}
                      </TableCell>
                      <TableCell>{fmtWhen(p.quota?.resetAt ?? null)}</TableCell>
                    </TableRow>
                  ))}
                  {data.pools.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                        {t('freeTier.empty')}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
