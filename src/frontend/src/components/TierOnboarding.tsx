import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Key,
  Play,
  Settings,
  Upload,
  Zap,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface TierModel {
  priority: number
  platform: string
  model_id: string
  display_name: string
  intelligence_rank: number
  supports_vision: boolean
  supports_tools: boolean
}

interface Tier {
  id: string
  name: string
  emoji: string
  color: string
  modelCount: number
  models: TierModel[]
}

interface Provider {
  name: string
  displayName: string
  emoji: string
  color: string
  apiKeyEnv: string
  baseURL: string
  apiType: string
  keyConfigured: boolean
  modelsCount: number
  tiers: string[]
  setupUrl: string
  status: 'configured' | 'missing'
}

interface DSHSettingsResponse {
  tiers: Tier[]
  providers: Provider[]
}

export interface TierOnboardingProps {
  onComplete?: () => void
  showHeader?: boolean
}

export function TierOnboarding({ onComplete, showHeader = true }: TierOnboardingProps) {
  const queryClient = useQueryClient()
  const [expandedTier, setExpandedTier] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; latency?: number; error?: string }>>({})
  const [importing, setImporting] = useState(false)

  const { data, isLoading, refetch } = useQuery<DSHSettingsResponse>({
    queryKey: ['dsh', 'settings'],
    queryFn: () => apiFetch('/api/dsh/settings'),
  })

  const testMutation = useMutation({
    mutationFn: (provider: Provider) =>
      apiFetch<{ success: boolean; latency?: number; error?: string }>('/api/dsh/test', {
        method: 'POST',
        body: JSON.stringify({
          providerName: provider.name,
          baseURL: provider.baseURL,
          apiKey: provider.keyConfigured ? 'test-key' : undefined,
        }),
      }),
    onSuccess: (result, provider) => {
      setTestResults(prev => ({ ...prev, [provider.name]: result }))
    },
  })

  const importMutation = useMutation({
    mutationFn: () => {
      setImporting(true)
      return apiFetch('/api/dsh/import', { method: 'POST' })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dsh', 'settings'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
    onSettled: () => setImporting(false),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-sm text-muted-foreground">Loading tier configuration...</div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-sm text-destructive">Failed to load DSH settings</div>
      </div>
    )
  }

  const totalModels = data.tiers.reduce((sum, t) => sum + t.modelCount, 0)
  const configuredProviders = data.providers.filter(p => p.keyConfigured).length
  const totalProviders = data.providers.length

  return (
    <div className="space-y-6">
      {showHeader && (
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl font-semibold">Tier Onboarding</h2>
          <p className="text-sm text-muted-foreground">
            Configure your tier chains and providers for optimal model routing
          </p>
        </div>
      )}

      {/* Stats Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card size="sm">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Total Models</div>
            <div className="text-2xl font-semibold mt-1">{totalModels}</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Providers</div>
            <div className="text-2xl font-semibold mt-1">
              {configuredProviders}/{totalProviders}
            </div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Tiers Active</div>
            <div className="text-2xl font-semibold mt-1">{data.tiers.length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Tier Cards */}
      <div className="space-y-3">
        <h3 className="text-lg font-medium">Tier Chains</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {data.tiers.map(tier => {
            const tierProviders = data.providers.filter(p =>
              p.tiers.includes(tier.name.replace('-Tier', '')) ||
              p.tiers.includes(tier.name)
            )
            const configuredCount = tierProviders.filter(p => p.keyConfigured).length

            return (
              <Card key={tier.id} className="overflow-hidden">
                <div
                  className="h-2"
                  style={{ backgroundColor: tier.color }}
                />
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <span className="text-2xl">{tier.emoji}</span>
                      <span>{tier.name}</span>
                    </CardTitle>
                    <Badge variant={configuredCount === tierProviders.length ? 'default' : 'secondary'}>
                      {tier.modelCount}
                    </Badge>
                  </div>
                  <CardDescription>
                    {tier.modelCount} models available
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {/* Status */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Providers</span>
                      <span className="font-medium">
                        {configuredCount}/{tierProviders.length}
                      </span>
                    </div>

                    {/* Provider Pills */}
                    <div className="flex flex-wrap gap-1">
                      {tierProviders.length === 0 ? (
                        <span className="text-xs text-muted-foreground">No providers mapped</span>
                      ) : (
                        tierProviders.map(p => (
                          <Badge
                            key={p.name}
                            variant={p.keyConfigured ? 'default' : 'outline'}
                            className="text-xs"
                            style={p.keyConfigured ? { backgroundColor: p.color } : {}}
                          >
                            {p.emoji} {p.displayName}
                            {p.keyConfigured ? (
                              <CheckCircle2 className="size-3 ml-1" />
                            ) : (
                              <AlertCircle className="size-3 ml-1" />
                            )}
                          </Badge>
                        ))
                      )}
                    </div>

                    {/* Expand/Collapse */}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-between"
                      onClick={() => setExpandedTier(expandedTier === tier.id ? null : tier.id)}
                    >
                      <span>View Models</span>
                      <ChevronDown
                        className={`size-4 transition-transform ${
                          expandedTier === tier.id ? 'rotate-180' : ''
                        }`}
                      />
                    </Button>

                    {/* Expanded Models */}
                    {expandedTier === tier.id && (
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {tier.models.slice(0, 8).map(model => (
                          <div
                            key={`${model.platform}-${model.model_id}`}
                            className="flex items-center justify-between text-xs p-2 rounded bg-muted/50"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="font-medium truncate">{model.display_name}</div>
                              <div className="text-muted-foreground truncate text-[10px]">
                                {model.platform} • Rank {model.intelligence_rank}
                              </div>
                            </div>
                            <div className="flex gap-1">
                              {model.supports_vision && (
                                <Badge variant="outline" className="text-[10px] px-1">👁</Badge>
                              )}
                              {model.supports_tools && (
                                <Badge variant="outline" className="text-[10px] px-1">🔧</Badge>
                              )}
                            </div>
                          </div>
                        ))}
                        {tier.models.length > 8 && (
                          <div className="text-xs text-center text-muted-foreground py-1">
                            +{tier.models.length - 8} more models
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      {/* Provider Status */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium">Provider Status</h3>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading}
            >
              <Settings className="size-4 mr-1" />
              Refresh
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => importMutation.mutate()}
              disabled={importing || importMutation.isPending}
            >
              <Upload className="size-4 mr-1" />
              {importing ? 'Importing...' : 'Import from DSH'}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {data.providers.map(provider => (
            <Card key={provider.name} size="sm">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div
                      className="size-10 rounded-lg flex items-center justify-center text-xl shrink-0"
                      style={{ backgroundColor: `${provider.color}20` }}
                    >
                      {provider.emoji}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{provider.displayName}</span>
                        {provider.keyConfigured ? (
                          <Badge variant="default" className="bg-green-500/20 text-green-700 dark:text-green-400">
                            <CheckCircle2 className="size-3 mr-1" />
                            Configured
                          </Badge>
                        ) : (
                          <Badge variant="destructive">
                            <AlertCircle className="size-3 mr-1" />
                            Missing Key
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 truncate">
                        {provider.baseURL}
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                        <span>Key: <code className="text-foreground">{provider.apiKeyEnv}</code></span>
                        {provider.tiers.length > 0 && (
                          <span>Tiers: {provider.tiers.join(', ')}</span>
                        )}
                      </div>

                      {/* Test Result */}
                      {testResults[provider.name] && (
                        <div className={`mt-2 text-xs ${testResults[provider.name].success ? 'text-green-600' : 'text-destructive'}`}>
                          {testResults[provider.name].success
                            ? `✓ Connected (${testResults[provider.name].latency}ms)`
                            : `✗ ${testResults[provider.name].error}`}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 shrink-0">
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => testMutation.mutate(provider)}
                      disabled={testMutation.isPending}
                    >
                      <Play className="size-3 mr-1" />
                      Test
                    </Button>
                    {!provider.keyConfigured && (
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => window.open(provider.setupUrl, '_blank', 'noopener,noreferrer')}
                      >
                        <Key className="size-3 mr-1" />
                        Get Key
                        <ExternalLink className="size-3 ml-1" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Complete Action */}
      {onComplete && (
        <div className="flex justify-end pt-4">
          <Button onClick={onComplete} size="lg">
            <Zap className="size-4 mr-2" />
            Complete Setup
          </Button>
        </div>
      )}
    </div>
  )
}