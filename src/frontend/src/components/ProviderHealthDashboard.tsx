import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Pause,
  Play,
  RefreshCw,
  XCircle,
  Zap,
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LineChart, Line } from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface HealthStatus {
  platform: string
  baseUrl: string | null
  healthy: boolean
  latencyMs: number
  error: string | null
  lastChecked: string
  uptime: number
}

interface HealthReport {
  platform: string
  baseUrl: string | null
  status: 'healthy' | 'degraded' | 'unhealthy'
  latencyMs: number
  error: string | null
  lastChecked: string
  uptime24h: number
  uptime7d: number
  uptime30d: number
  totalChecks: number
  successfulChecks: number
  failedChecks: number
}

interface UptimeStats {
  platform: string
  period: string
  uptime: number
  totalChecks: number
  successfulChecks: number
  avgLatencyMs: number
  lastCheck: string | null
  downtimeIncidents: DowntimeIncident[]
}

interface DowntimeIncident {
  start: string
  end: string | null
  durationMs: number | null
  error: string
}

export function ProviderHealthDashboard() {
  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null)
  const [monitoring, setMonitoring] = useState(false)
  const queryClient = useQueryClient()

  // Get all provider health reports
  const providersQuery = useQuery<HealthReport[]>({
    queryKey: ['health', 'providers'],
    queryFn: async () => {
      const res = await apiFetch('/api/health/providers')
      if (!res.ok) throw new Error('Failed to fetch health')
      return res.json()
    },
    refetchInterval: 30000, // refresh every 30s
  })

  // Get uptime for selected platform
  const uptimeQuery = useQuery<UptimeStats>({
    queryKey: ['health', 'uptime', selectedPlatform],
    queryFn: async () => {
      if (!selectedPlatform) return null
      const res = await apiFetch(`/api/health/uptime/${selectedPlatform}?period=day`)
      if (!res.ok) throw new Error('Failed to fetch uptime')
      return res.json()
    },
    enabled: !!selectedPlatform,
  })

  // Trigger health check
  const checkMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/health/check', { method: 'POST' })
      if (!res.ok) throw new Error('Check failed')
      return res.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  // Start/stop monitoring
  const startMonitoringMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/health/monitor/start?intervalMs=60000', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to start monitoring')
      return res.json()
    },
    onSuccess: () => setMonitoring(true),
  })

  const stopMonitoringMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/health/monitor/stop', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to stop monitoring')
      return res.json()
    },
    onSuccess: () => setMonitoring(false),
  })

  const getStatusIcon = (status: string) => {
    if (status === 'healthy') return <CheckCircle2 className="h-5 w-5 text-green-500" />
    if (status === 'degraded') return <AlertCircle className="h-5 w-5 text-yellow-500" />
    return <XCircle className="h-5 w-5 text-red-500" />
  }

  const getStatusColor = (status: string) => {
    if (status === 'healthy') return 'bg-green-100 text-green-800'
    if (status === 'degraded') return 'bg-yellow-100 text-yellow-800'
    return 'bg-red-100 text-red-800'
  }

  const healthyCount = providersQuery.data?.filter(p => p.status === 'healthy').length ?? 0
  const totalCount = providersQuery.data?.length ?? 0

  return (
    <div className="p-6 space-y-6 bg-gray-50 dark:bg-gray-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Provider Health</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Real-time health monitoring for all providers
          </p>
        </div>
        <div className="flex space-x-2">
          <Button
            onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
            variant="outline"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${checkMutation.isPending ? 'animate-spin' : ''}`} />
            Check Now
          </Button>
          {monitoring ? (
            <Button
              onClick={() => stopMonitoringMutation.mutate()}
              variant="destructive"
            >
              <Pause className="h-4 w-4 mr-2" />
              Stop Monitoring
            </Button>
          ) : (
            <Button
              onClick={() => startMonitoringMutation.mutate()}
              variant="default"
            >
              <Play className="h-4 w-4 mr-2" />
              Start Monitoring
            </Button>
          )}
        </div>
      </div>

      {/* Status Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Providers</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Healthy</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">{healthyCount}</div>
            <p className="text-xs text-muted-foreground">
              {totalCount > 0 ? Math.round((healthyCount / totalCount) * 100) : 0}% operational
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Monitoring</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {monitoring ? 'Active' : 'Inactive'}
            </div>
            <p className="text-xs text-muted-foreground">
              {monitoring ? 'Auto-checking every 60s' : 'Manual checks only'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Last Check</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-sm">
              {providersQuery.data?.[0]?.lastChecked
                ? new Date(providersQuery.data[0].lastChecked).toLocaleTimeString()
                : 'Never'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Provider Health Grid */}
      <Card>
        <CardHeader>
          <CardTitle>Provider Health Grid</CardTitle>
          <CardDescription>Click a provider to see detailed uptime stats</CardDescription>
        </CardHeader>
        <CardContent>
          {providersQuery.isLoading ? (
            <div className="text-center py-8 text-gray-500">Loading...</div>
          ) : providersQuery.data && providersQuery.data.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {providersQuery.data.map((provider) => (
                <button
                  key={`${provider.platform}-${provider.baseUrl ?? 'default'}`}
                  onClick={() => setSelectedPlatform(provider.platform)}
                  className={`p-4 border rounded-lg text-left transition-all hover:shadow-md ${
                    selectedPlatform === provider.platform
                      ? 'border-blue-500 ring-2 ring-blue-200'
                      : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium">{provider.platform}</div>
                    {getStatusIcon(provider.status)}
                  </div>

                  <Badge className={getStatusColor(provider.status)} variant="secondary">
                    {provider.status}
                  </Badge>

                  <div className="mt-3 space-y-1 text-xs text-gray-600 dark:text-gray-400">
                    <div className="flex justify-between">
                      <span>Latency:</span>
                      <span className="font-mono">{provider.latencyMs}ms</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Uptime 24h:</span>
                      <span className="font-mono">{provider.uptime24h.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Uptime 7d:</span>
                      <span className="font-mono">{provider.uptime7d.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Uptime 30d:</span>
                      <span className="font-mono">{provider.uptime30d.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Checks:</span>
                      <span className="font-mono">{provider.successfulChecks}/{provider.totalChecks}</span>
                    </div>
                  </div>

                  {provider.error && (
                    <div className="mt-2 text-xs text-red-600 dark:text-red-400 truncate">
                      {provider.error}
                    </div>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <Activity className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No providers configured. Add API keys to start monitoring.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Selected Provider Details */}
      {selectedPlatform && uptimeQuery.data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{selectedPlatform} - Uptime Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div>
                  <div className="text-sm text-gray-600">Uptime</div>
                  <div className="text-2xl font-bold">{uptimeQuery.data.uptime.toFixed(2)}%</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Total Checks</div>
                  <div className="text-xl">{uptimeQuery.data.totalChecks}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Successful</div>
                  <div className="text-xl text-green-600">{uptimeQuery.data.successfulChecks}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Avg Latency</div>
                  <div className="text-xl font-mono">{uptimeQuery.data.avgLatencyMs}ms</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Downtime Incidents</CardTitle>
            </CardHeader>
            <CardContent>
              {uptimeQuery.data.downtimeIncidents.length > 0 ? (
                <div className="space-y-2">
                  {uptimeQuery.data.downtimeIncidents.map((incident, i) => (
                    <div key={i} className="p-2 border rounded text-sm">
                      <div className="font-mono text-xs">
                        {new Date(incident.start).toLocaleString()}
                      </div>
                      {incident.end && (
                        <div className="text-xs text-gray-500">
                          Duration: {Math.round((incident.durationMs || 0) / 1000)}s
                        </div>
                      )}
                      <div className="text-red-600 text-xs mt-1">{incident.error}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center text-gray-500 py-4">
                  <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-green-500" />
                  <p>No downtime incidents</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

export default ProviderHealthDashboard