import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'
import { Button } from '@/components/ui/button'

export interface ImageModel {
  slug: string
  name: string
  shortName: string
  author: string
  authorDisplayName: string
  description: string
  contextLength: number
  inputModalities: string[]
  outputModalities: string[]
  supportsReasoning: boolean
  isFree: boolean
  pricing: { prompt: string; completion: string } | null
  rpmLimit: number | null
  rpdLimit: number | null
  providerDisplayName: string
  providerSlug: string
  hasKey: boolean
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export default function ImageModelsPage() {
  const [copied, setCopied] = useState<string | null>(null)

  const { data: models = [], isLoading } = useQuery<ImageModel[]>({
    queryKey: ['image-models'],
    queryFn: () => apiFetch('/api/image-models'),
    staleTime: 10 * 60 * 1000,
  })

  return (
    <div>
      <PageHeader
        title="Models"
        description="Image generation models available via OpenRouter. Only OpenRouter supports text-to-image at the moment."
        divider={false}
        actions={<ModelsTabs />}
      />

      <div className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading image models…</p>
        ) : models.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No image generation models found on OpenRouter.
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">{models.length}</span> free image models available via{' '}
              <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]">OpenRouter</code>.
            </p>

            <div className="rounded-2xl border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2.5 pl-4 pr-3 font-medium">Model</th>
                    <th className="py-2.5 pr-3 font-medium">
                      <Tooltip text="Maximum context length in tokens">
                        <span className="underline decoration-dotted underline-offset-2 cursor-help">Context</span>
                      </Tooltip>
                    </th>
                    <th className="py-2.5 pr-4 font-medium">Input</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map(m => {
                    const isCopied = copied === m.slug
                    return (
                      <tr key={m.slug} className="border-b last:border-0 transition-colors">
                        <td className="py-2.5 pl-4 pr-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{m.shortName}</span>
                            {m.supportsReasoning && (
                              <span
                                title="Supports chain-of-thought reasoning"
                                className="text-[10px] rounded-full px-1.5 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400"
                              >
                                Reasoning
                              </span>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[10px]"
                              onClick={() => {
                                navigator.clipboard.writeText(m.slug)
                                setCopied(m.slug)
                                setTimeout(() => setCopied(null), 2000)
                              }}
                            >
                              {isCopied ? 'Copied' : 'Copy'}
                            </Button>
                          </div>
                          <div className="text-[11px] text-muted-foreground/70 font-mono mt-0.5">{m.slug}</div>
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground tabular-nums">
                          {m.contextLength > 0 ? formatNumber(m.contextLength) : '–'}
                        </td>
                        <td className="py-2.5 pr-4">
                          <div className="flex gap-1 flex-wrap">
                            {m.inputModalities.map(mod => (
                              <span
                                key={mod}
                                className="text-[10px] rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground"
                              >
                                {mod}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}


