import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import {
  AlertCircle,
  CheckCircle2,
  Key,
  Loader2,
  Pause,
  Play,
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

interface TestResult {
  success: boolean
  latency?: number
  error?: string
}

export interface ProviderStatusProps {
  compact?: boolean
  filterTier?: string
  onConfigure?: (provider: Provider) => void
}

export function ProviderStatus({ compact = false, filterTier, onConfigure }: ProviderStatusProps) {
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [testingProvider, setTestingProvider] = useState<string | null>(null)

  const { data, isLoading } = useQuery<{ providers: Provider[] }>({
    queryKey: ['dsh', 'settings'],
    queryFn: () => apiFetch('/api/dsh/settings'),
  })

  const testMutation = useMutation({
    mutationFn: (provider: Provider) =>
      apiFetch<TestResult>('/api/dsh/test', {
        method: 'POST',
        body: JSON.stringify({
          providerName: provider.name,
          baseURL: provider.baseURL,
        }),
      }),
    onSuccess: (result, provider) => {
      setTestResults(prev => ({ ...prev, [provider.name]: result }))
      setTestingProvider(null)
    },
    onError: (error, provider) => {
      setTestResults(prev => ({
        ...prev,
        [provider.name]: { success: false, error: (error as Error).message },
      }))
      setTestingProvider(null)
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="size-4 animate-spin mr-2" />
        <span className="text-sm text-muted-foreground">Loading providers...</span>
      </div>
    )
  }

  if (!data?.providers) {
    return (
      <div className="text-sm text-muted-foreground p-4">No providers configured</div>
    )
  }

  let providers = data.providers
  if (filterTier) {
    providers = providers.filter(p =>
      p.tiers.some(t => t.toLowerCase().includes(filterTier.toLowerCase()))
    )
  }

  if (providers.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center">
        No providers for this tier
      </div>
    )
  }

  if (compact) {
    return (
      <div className="space-y-2">
        {providers.map(provider => (
          <ProviderRow
            key={provider.name}
            provider={provider}
            testResult={testResults[provider.name]}
            isTesting={testingProvider === provider.name}
            onTest={() => {
              setTestingProvider(provider.name)
              testMutation.mutate(provider)
            }}
            onConfigure={onConfigure}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {providers.map(provider => (
        <Card key={provider.name}>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div
                className="size-12 rounded-lg flex items-center justify-center text-2xl"
                style={{ backgroundColor: `${provider.color}20` }}
              >
                {provider.emoji}
              </div>
              {provider.keyConfigured ? (
                <Badge variant="default" className="bg-green-500/20 text-green-700 dark:text-green-400">
                  <CheckCircle2 className="size-3 mr-1" />
                  Live
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <AlertCircle className="size-3 mr-1" />
                  Off
                </Badge>
              )}
            </div>
            <CardTitle className="mt-3">{provider.displayName}</CardTitle>
            <CardDescription className="text-xs truncate">{provider.baseURL}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {/* Stats */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-muted/50 rounded p-2">
                  <div className="text-muted-foreground">Models</div>
                  <div className="font-semibold">{provider.modelsCount}</div>
                </div>
                <div className="bg-muted/50 rounded p-2">
                  <div className="text-muted-foreground">Tiers</div>
                  <div className="font-semibold">{provider.tiers.length}</div>
                </div>
              </div>

              {/* Tiers */}
              {provider.tiers.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {provider.tiers.map(tier => (
                    <Badge key={tier} variant="outline" className="text-xs">
                      {tier}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Test Result */}
              {testResults[provider.name] && (
                <div className={`text-xs p-2 rounded ${
                  testResults[provider.name].success
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                    : 'bg-destructive/10 text-destructive'
                }`}>
                  {testResults[provider.name].success
                    ? `✓ ${testResults[provider.name].latency}ms`
                    : `✗ ${testResults[provider.name].error}`}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-1 pt-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="flex-1"
                  onClick={() => {
                    setTestingProvider(provider.name)
                    testMutation.mutate(provider)
                  }}
                  disabled={testingProvider === provider.name}
                >
                  {testingProvider === provider.name ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Play className="size-3" />
                  )}
                </Button>
                {provider.keyConfigured ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onConfigure?.(provider)}
                  >
                    <Pause className="size-3" />
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="xs"
                    className="flex-1"
                    onClick={() => window.open(provider.setupUrl, '_blank', 'noopener,noreferrer')}
                  >
                    <Key className="size-3 mr-1" />
                    Add Key
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

interface ProviderRowProps {
  provider: Provider
  testResult?: TestResult
  isTesting: boolean
  onTest: () => void
  onConfigure?: (provider: Provider) => void
}

function ProviderRow({ provider, testResult, isTesting, onTest, onConfigure }: ProviderRowProps) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors">
      <div
        className="size-9 rounded-lg flex items-center justify-center text-lg shrink-0"
        style={{ backgroundColor: `${provider.color}20` }}
      >
        {provider.emoji}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{provider.displayName}</span>
          {provider.keyConfigured ? (
            <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
          ) : (
            <AlertCircle className="size-3.5 text-destructive shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
          <span className="truncate">{provider.modelsCount} models</span>
          {provider.tiers.length > 0 && (
            <>
              <span>•</span>
              <span className="truncate">{provider.tiers.join(', ')}</span>
            </>
          )}
        </div>
        {testResult && (
          <div className={`text-xs mt-1 ${testResult.success ? 'text-green-600' : 'text-destructive'}`}>
            {testResult.success ? `✓ ${testResult.latency}ms` : `✗ ${testResult.error}`}
          </div>
        )}
      </div>

      <div className="flex gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onTest}
          disabled={isTesting}
          title="Test connection"
        >
          {isTesting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Play className="size-3" />
          )}
        </Button>
        {provider.keyConfigured ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onConfigure?.(provider)}
            title="Disable"
          >
            <Pause className="size-3" />
          </Button>
        ) : (
          <Button
            variant="default"
            size="xs"
            onClick={() => window.open(provider.setupUrl, '_blank', 'noopener,noreferrer')}
            title="Get API Key"
          >
            <Key className="size-3 mr-1" />
            Add
          </Button>
        )}
      </div>
    </div>
  )
}