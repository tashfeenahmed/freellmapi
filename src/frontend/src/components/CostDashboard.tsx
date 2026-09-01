import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DollarSign,
  TrendingDown,
  TrendingUp,
  Zap,
  RefreshCw,
  Database,
  Calendar,
  BarChart3,
} from 'lucide-react'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface CostBreakdown {
  model: string
  platform: string
  inputTokens: number
  outputTokens: number
  cached: boolean
  inputCostPerM: number
  outputCostPerM: number
  inputCost: number
  outputCost: number
  cacheDiscount: number
  cacheSavings: number
  totalCost: number
  effectiveCost: number
}

interface DailyReport {
  date: string
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  totalSavings: number
  byModel: ModelCostSummary[]
  byProvider: ProviderCostSummary[]
}

interface MonthlyReport {
  month: string
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  totalSavings: number
  byDay: DailySummary[]
  byModel: ModelCostSummary[]
  byProvider: ProviderCostSummary[]
}

interface ModelCostSummary {
  model: string
  platform: string
  requests: number
  inputTokens: number
  outputTokens: number
  cost: number
  savings: number
}

interface ProviderCostSummary {
  platform: string
  requests: number
  inputTokens: number
  outputTokens: number
  cost: number
  savings: number
}

interface DailySummary {
  date: string
  requests: number
  inputTokens: number
  outputTokens: number
  cost: number
  savings: number
}

interface SavingsReport {
  period: string
  totalCostWithoutCache: number
  totalCostWithCache: number
  totalSavings: number
  savingsPercent: number
  cacheHitRate: number
  byProvider: ProviderSavingsSummary[]
}

interface ProviderSavingsSummary {
  platform: string
  totalCost: number
  savings: number
  savingsPercent: number
  cacheHitRate: number
}

interface ProviderCost {
  platform: string
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  requests: number
  averageCostPerRequest: number
}

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D', '#FFC658', '#FF7C7C']

export function CostDashboard() {
  const [activeTab, setActiveTab] = useState<'daily' | 'monthly' | 'savings' | 'top'>('daily')
  const queryClient = useQueryClient()

  // Daily report
  const dailyQuery = useQuery<DailyReport>({
    queryKey: ['cost', 'daily'],
    queryFn: async () => {
      const res = await apiFetch('/api/cost/daily')
      if (!res.ok) throw new Error('Failed to fetch daily report')
      return res.json()
    },
  })

  // Monthly report
  const monthlyQuery = useQuery<MonthlyReport>({
    queryKey: ['cost', 'monthly'],
    queryFn: async () => {
      const res = await apiFetch('/api/cost/monthly')
      if (!res.ok) throw new Error('Failed to fetch monthly report')
      return res.json()
    },
  })

  // Savings report
  const savingsQuery = useQuery<SavingsReport>({
    queryKey: ['cost', 'savings'],
    queryFn: async () => {
      const res = await apiFetch('/api/cost/savings?period=day')
      if (!res.ok) throw new Error('Failed to fetch savings report')
      return res.json()
    },
  })

  // Provider costs
  const providerCostsQuery = useQuery<ProviderCost[]>({
    queryKey: ['cost', 'providers'],
    queryFn: async () => {
      const res = await apiFetch('/api/cost/providers')
      if (!res.ok) throw new Error('Failed to fetch provider costs')
      return res.json()
    },
  })

  // Top expensive models
  const topModelsQuery = useQuery<ModelCostSummary[]>({
    queryKey: ['cost', 'top'],
    queryFn: async () => {
      const res = await apiFetch('/api/cost/top?limit=10')
      if (!res.ok) throw new Error('Failed to fetch top models')
      return res.json()
    },
  })

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ['cost'] })
  }

  // Prepare chart data
  const dailyProviderData = (dailyQuery.data?.byProvider || []).map((p) => ({
    name: p.platform,
    cost: p.cost,
    savings: p.savings,
  }))

  const monthlyDailyData = (monthlyQuery.data?.byDay || []).map((d) => ({
    date: d.date,
    cost: d.cost,
    savings: d.savings,
  }))

  return (
    <div className="p-6 space-y-6 bg-gray-50 dark:bg-gray-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Cost Calculator</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Track spending across providers and models with DSH cache savings
          </p>
        </div>
        <Button onClick={refreshAll} variant="outline">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Today Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${dailyQuery.data?.totalCost?.toFixed(4) ?? '0.0000'}
            </div>
            <p className="text-xs text-muted-foreground">
              {dailyQuery.data?.totalRequests ?? 0} requests
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Today Savings</CardTitle>
            <TrendingDown className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              ${dailyQuery.data?.totalSavings?.toFixed(4) ?? '0.0000'}
            </div>
            <p className="text-xs text-muted-foreground">From DSH caching</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cache Hit Rate</CardTitle>
            <Zap className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {((savingsQuery.data?.cacheHitRate ?? 0) * 100).toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">DSH cache effectiveness</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Month Cost</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${monthlyQuery.data?.totalCost?.toFixed(2) ?? '0.00'}
            </div>
            <p className="text-xs text-muted-foreground">
              Saved: ${monthlyQuery.data?.totalSavings?.toFixed(2) ?? '0.00'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex space-x-2 border-b">
        <button
          onClick={() => setActiveTab('daily')}
          className={`px-4 py-2 font-medium ${
            activeTab === 'daily'
              ? 'border-b-2 border-blue-500 text-blue-600'
              : 'text-gray-500'
          }`}
        >
          Daily Report
        </button>
        <button
          onClick={() => setActiveTab('monthly')}
          className={`px-4 py-2 font-medium ${
            activeTab === 'monthly'
              ? 'border-b-2 border-blue-500 text-blue-600'
              : 'text-gray-500'
          }`}
        >
          Monthly Report
        </button>
        <button
          onClick={() => setActiveTab('savings')}
          className={`px-4 py-2 font-medium ${
            activeTab === 'savings'
              ? 'border-b-2 border-blue-500 text-blue-600'
              : 'text-gray-500'
          }`}
        >
          Savings Calculator
        </button>
        <button
          onClick={() => setActiveTab('top')}
          className={`px-4 py-2 font-medium ${
            activeTab === 'top'
              ? 'border-b-2 border-blue-500 text-blue-600'
              : 'text-gray-500'
          }`}
        >
          Top 10 Expensive
        </button>
      </div>

      {/* Daily Tab */}
      {activeTab === 'daily' && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Cost by Provider (Today)</CardTitle>
              <CardDescription>
                Breakdown of today's spending across all providers
              </CardDescription>
            </CardHeader>
            <CardContent>
              {dailyProviderData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={dailyProviderData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="cost" fill="#0088FE" name="Cost ($)" />
                    <Bar dataKey="savings" fill="#00C49F" name="Savings ($)" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-center py-12 text-gray-500">
                  <Database className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>No data for today yet. Send some requests first.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Monthly Tab */}
      {activeTab === 'monthly' && (
        <Card>
          <CardHeader>
            <CardTitle>Monthly Trend</CardTitle>
            <CardDescription>
              Daily costs and savings for the current month
            </CardDescription>
          </CardHeader>
          <CardContent>
            {monthlyDailyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={400}>
                <LineChart data={monthlyDailyData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="cost" stroke="#0088FE" name="Cost ($)" />
                  <Line type="monotone" dataKey="savings" stroke="#00C49F" name="Savings ($)" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <BarChart3 className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No monthly data available yet.</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Savings Tab */}
      {activeTab === 'savings' && savingsQuery.data && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Cost Without Cache</CardTitle>
              <CardDescription>Full price if every request was paid</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                ${savingsQuery.data.totalCostWithoutCache.toFixed(4)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cost With Cache</CardTitle>
              <CardDescription>Actual cost after DSH caching</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-600">
                ${savingsQuery.data.totalCostWithCache.toFixed(4)}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Total Savings</CardTitle>
              <CardDescription>Money saved by caching</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-600">
                ${savingsQuery.data.totalSavings.toFixed(4)}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {savingsQuery.data.savingsPercent.toFixed(2)}% savings
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cache Hit Rate</CardTitle>
              <CardDescription>Effectiveness of DSH caching</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">
                {(savingsQuery.data.cacheHitRate * 100).toFixed(1)}%
              </div>
            </CardContent>
          </Card>

          {savingsQuery.data.byProvider.length > 0 && (
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>Savings by Provider</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={savingsQuery.data.byProvider}
                      dataKey="savings"
                      nameKey="platform"
                      cx="50%"
                      cy="50%"
                      outerRadius={100}
                      label
                    >
                      {savingsQuery.data.byProvider.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Top Expensive Models Tab */}
      {activeTab === 'top' && (
        <Card>
          <CardHeader>
            <CardTitle>Top 10 Most Expensive Models</CardTitle>
            <CardDescription>Models with highest cumulative cost</CardDescription>
          </CardHeader>
          <CardContent>
            {topModelsQuery.data && topModelsQuery.data.length > 0 ? (
              <div className="space-y-2">
                {topModelsQuery.data.map((model, i) => (
                  <div
                    key={`${model.platform}-${model.model}`}
                    className="flex items-center justify-between p-3 border rounded"
                  >
                    <div className="flex items-center space-x-3">
                      <Badge variant="outline">{i + 1}</Badge>
                      <div>
                        <div className="font-medium">{model.model}</div>
                        <div className="text-sm text-gray-500">{model.platform}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">${model.cost.toFixed(4)}</div>
                      <div className="text-sm text-gray-500">
                        {model.requests} requests
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <TrendingUp className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No model usage data yet.</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Provider Costs Table */}
      {providerCostsQuery.data && providerCostsQuery.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>All Provider Costs</CardTitle>
            <CardDescription>Total cost per provider</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {providerCostsQuery.data.map((p) => (
                <div
                  key={p.platform}
                  className="flex items-center justify-between p-3 border rounded"
                >
                  <div>
                    <div className="font-medium">{p.platform}</div>
                    <div className="text-sm text-gray-500">
                      {p.requests} requests · {p.totalInputTokens.toLocaleString()} in / {p.totalOutputTokens.toLocaleString()} out tokens
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">${p.totalCost.toFixed(4)}</div>
                    <div className="text-sm text-gray-500">
                      ${p.averageCostPerRequest.toFixed(6)}/req
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export default CostDashboard