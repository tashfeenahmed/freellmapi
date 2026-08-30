import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Database,
  RefreshCw,
  Sparkles,
  Globe,
  PlusCircle,
  CheckCircle2,
  AlertCircle,
  Clock,
  Power,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface DiscoveryStatus {
  lastSync: string | null
  lastSyncStatus: string
  lastError: string | null
  appliedVersion: string | null
  appliedTier: string | null
  nextSyncIn: number | null
  newModelsCount: number
  autoSyncEnabled: boolean
}

interface ModelInfo {
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  contextWindow: number | null
  supportsVision: boolean
  supportsTools: boolean
  limits: {
    rpm: number | null
    rpd: number | null
    tpm: number | null
    tpd: number | null
  }
  monthlyTokenBudget: string | null
}

interface SyncReport {
  ok: boolean
  action: string
  version?: string
  tier?: string
  detail?: string
  counts?: {
    updated: number
    inserted: number
    removed: number
    skippedUnknownPlatform: number
    quirks: number
  }
  newModels?: ModelInfo[]
}

function formatTimeUntil(ms: number | null): string {
  if (ms === null || ms <= 0) return 'now'
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function DiscoveryStatus() {
  const queryClient = useQueryClient()

  // Get discovery status
  const statusQuery = useQuery<DiscoveryStatus>({
    queryKey: ['discovery', 'status'],
    queryFn: async () => {
      const res = await apiFetch('/api/discovery/status')
      if (!res.ok) throw new Error('Failed to fetch status')
      return res.json()
    },
    refetchInterval: 10000,
  })

  // Get new models
  const newModelsQuery = useQuery<ModelInfo[]>({
    queryKey: ['discovery', 'new'],
    queryFn: async () => {
      const res = await apiFetch('/api/discovery/new?limit=20')
      if (!res.ok) throw new Error('Failed to fetch new models')
      return res.json()
    },
  })

  // Get new providers
  const newProvidersQuery = useQuery<string[]>({
    queryKey: ['discovery', 'new-providers'],
    queryFn: async () => {
      const res = await apiFetch('/api/discovery/new-providers')
      if (!res.ok) throw new Error('Failed to fetch new providers')
      return res.json()
    },
  })

  // Trigger manual sync
  const syncMutation = useMutation<SyncReport, Error, boolean>({
    mutationFn: async (force) => {
      const res = await apiFetch(`/api/discovery/sync?force=${force}`, { method: 'POST' })
      if (!res.ok) throw new Error('Sync failed')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discovery'] })
    },
  })

  // Auto-add models
  const autoAddMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/discovery/auto-add', { method: 'POST' })
      if (!res.ok) throw new Error('Auto-add failed')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discovery'] })
    },
  })

  // Start/stop scheduled sync
  const startSchedulerMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/discovery/scheduler/start?intervalHours=12', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to start scheduler')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discovery'] })
    },
  })

  const stopSchedulerMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/discovery/scheduler/stop', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to stop scheduler')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discovery'] })
    },
  })

  const status = statusQuery.data
  const syncResult = syncMutation.data

  return (
    <div className="p-6 space-y-6 bg-gray-50 dark:bg-gray-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            Catalog Discovery
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Auto-discover and sync models from the FreeLLMAPI catalog
          </p>
        </div>
        <div className="flex space-x-2">
          <Button
            onClick={() => syncMutation.mutate(true)}
            disabled={syncMutation.isPending}
            variant="default"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
            {syncMutation.isPending ? 'Syncing...' : 'Sync Now'}
          </Button>
        </div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Status</CardTitle>
            {status?.lastError ? (
              <AlertCircle className="h-4 w-4 text-red-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {status?.lastSyncStatus === 'applied' && (
                <Badge className="bg-green-100 text-green-800">Applied</Badge>
              )}
              {status?.lastSyncStatus === 'up_to_date' && (
                <Badge className="bg-blue-100 text-blue-800">Up to date</Badge>
              )}
              {status?.lastSyncStatus === 'error' && (
                <Badge className="bg-red-100 text-red-800">Error</Badge>
              )}
              {status?.lastSyncStatus === 'unknown' && (
                <Badge variant="outline">Unknown</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              v{status?.appliedVersion ?? 'N/A'} ({status?.appliedTier ?? 'N/A'})
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Last Sync</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium">
              {status?.lastSync
                ? new Date(status.lastSync).toLocaleString()
                : 'Never'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Next Sync</CardTitle>
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatTimeUntil(status?.nextSyncIn ?? null)}
            </div>
            <p className="text-xs text-muted-foreground">Auto sync</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">New Models</CardTitle>
            <Sparkles className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {newModelsQuery.data?.length ?? 0}
            </div>
            <p className="text-xs text-muted-foreground">Not yet added</p>
          </CardContent>
        </Card>
      </div>

      {/* Last Sync Details */}
      {syncResult && (
        <Card>
          <CardHeader>
            <CardTitle>Last Sync Result</CardTitle>
            <CardDescription>
              {syncResult.ok ? 'Sync completed' : 'Sync failed'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {syncResult.counts && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div>
                  <div className="text-sm text-gray-600">Inserted</div>
                  <div className="text-2xl font-bold text-green-600">
                    {syncResult.counts.inserted}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Updated</div>
                  <div className="text-2xl font-bold text-blue-600">
                    {syncResult.counts.updated}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Removed</div>
                  <div className="text-2xl font-bold text-red-600">
                    {syncResult.counts.removed}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Quirks</div>
                  <div className="text-2xl font-bold text-purple-600">
                    {syncResult.counts.quirks}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Skipped</div>
                  <div className="text-2xl font-bold text-gray-600">
                    {syncResult.counts.skippedUnknownPlatform}
                  </div>
                </div>
              </div>
            )}
            {syncResult.detail && (
              <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 rounded text-sm">
                {syncResult.detail}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* New Providers */}
      {newProvidersQuery.data && newProvidersQuery.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <Globe className="h-4 w-4 inline mr-2" />
              New Providers Discovered
            </CardTitle>
            <CardDescription>
              Providers in the catalog without configured keys
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {newProvidersQuery.data.map((provider) => (
                <Badge key={provider} variant="outline" className="text-sm">
                  {provider}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* New Models */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>New Models</CardTitle>
              <CardDescription>
                Recently added models from the catalog
              </CardDescription>
            </div>
            {newModelsQuery.data && newModelsQuery.data.length > 0 && (
              <Button
                onClick={() => autoAddMutation.mutate()}
                disabled={autoAddMutation.isPending}
                size="sm"
              >
                <PlusCircle className="h-4 w-4 mr-2" />
                Auto-Add All
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {newModelsQuery.isLoading ? (
            <div className="text-center py-8 text-gray-500">Loading...</div>
          ) : newModelsQuery.data && newModelsQuery.data.length > 0 ? (
            <div className="space-y-2">
              {newModelsQuery.data.map((model) => (
                <div
                  key={`${model.platform}-${model.modelId}`}
                  className="flex items-center justify-between p-3 border rounded"
                >
                  <div className="flex-1">
                    <div className="font-medium">{model.displayName}</div>
                    <div className="text-sm text-gray-500">
                      {model.platform} · {model.modelId}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {model.supportsVision && (
                        <Badge variant="secondary" className="text-xs">Vision</Badge>
                      )}
                      {model.supportsTools && (
                        <Badge variant="secondary" className="text-xs">Tools</Badge>
                      )}
                      {model.contextWindow && (
                        <Badge variant="outline" className="text-xs">
                          {model.contextWindow.toLocaleString()} ctx
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="text-right text-xs text-gray-500">
                    <div>IQ Rank: {model.intelligenceRank}</div>
                    <div>Speed: {model.speedRank}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <Database className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No new models to display</p>
              <p className="text-sm mt-1">Run a sync to discover new models</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Scheduler Controls */}
      <Card>
        <CardHeader>
          <CardTitle>Scheduled Sync</CardTitle>
          <CardDescription>
            Automatic catalog sync at regular intervals
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm">
                Status: <span className="font-medium">
                  {status?.autoSyncEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {status?.autoSyncEnabled
                  ? 'CATALOG_SYNC_DISABLED is not set'
                  : 'Set CATALOG_SYNC_DISABLED=0 to enable'}
              </div>
            </div>
            <div className="flex space-x-2">
              <Button
                onClick={() => startSchedulerMutation.mutate()}
                disabled={startSchedulerMutation.isPending}
                variant="outline"
                size="sm"
              >
                <Power className="h-4 w-4 mr-2" />
                Start Scheduler
              </Button>
              <Button
                onClick={() => stopSchedulerMutation.mutate()}
                disabled={stopSchedulerMutation.isPending}
                variant="outline"
                size="sm"
              >
                <Power className="h-4 w-4 mr-2" />
                Stop Scheduler
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error Display */}
      {status?.lastError && (
        <Card>
          <CardHeader>
            <CardTitle className="text-red-600">Last Error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-sm bg-red-50 dark:bg-red-900/20 p-3 rounded overflow-auto">
              {status.lastError}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default DiscoveryStatus