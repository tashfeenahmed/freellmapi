import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts'
import { Activity, Wifi, WifiOff, Clock, Zap } from 'lucide-react'
import { useRealtimeRequests, useRealtimeTraces } from '@/hooks/useRealtimeStore'

export function RealtimeMonitor() {
  const [view, setView] = useState<'requests' | 'traces'>('requests')
  const { requests, connected: reqConnected } = useRealtimeRequests()
  const { traces, connected: traceConnected } = useRealtimeTraces()

  const data = view === 'requests' ? requests : traces
  const connected = view === 'requests' ? reqConnected : traceConnected

  // Calculate stats
  const totalRequests = data.length
  const successCount = data.filter((r: any) => r.status === 'success').length
  const errorCount = data.filter((r: any) => r.status === 'error').length
  const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0
  const avgLatency = data.length > 0
    ? data.reduce((sum: number, r: any) => sum + (r.latency_ms || 0), 0) / data.length
    : 0

  // Group by model for chart
  const modelStats = data.reduce((acc: any, req: any) => {
    const key = req.model_id
    if (!acc[key]) {
      acc[key] = { model: key, count: 0, errors: 0, totalLatency: 0 }
    }
    acc[key].count++
    if (req.status === 'error') acc[key].errors++
    acc[key].totalLatency += req.latency_ms || 0
    return acc
  }, {})

  const chartData = Object.values(modelStats).map((stat: any) => ({
    model: stat.model.substring(0, 20),
    count: stat.count,
    errors: stat.errors,
    avgLatency: stat.totalLatency / stat.count,
  }))

  // Timeline data (last 60 seconds)
  const now = Date.now()
  const timelineData = Array.from({ length: 12 }, (_, i) => {
    const bucketStart = now - (11 - i) * 5000
    const bucketEnd = bucketStart + 5000
    const inBucket = data.filter((r: any) => {
      const t = new Date(r.created_at).getTime()
      return t >= bucketStart && t < bucketEnd
    })
    return {
      time: new Date(bucketStart).toLocaleTimeString(),
      requests: inBucket.length,
      errors: inBucket.filter((r: any) => r.status === 'error').length,
    }
  })

  return (
    <div className="p-6 space-y-6 bg-gray-50 dark:bg-gray-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center">
            Real-Time Monitor
            <span className="ml-3 inline-flex items-center text-sm font-normal">
              {connected ? (
                <>
                  <Wifi className="w-4 h-4 text-green-500 mr-1" />
                  <span className="text-green-600">Live</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-4 h-4 text-red-500 mr-1" />
                  <span className="text-red-600">Disconnected</span>
                </>
              )}
            </span>
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Streaming {view} via Server-Sent Events
          </p>
        </div>

        {/* View Toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => setView('requests')}
            className={`px-4 py-2 rounded-md ${
              view === 'requests'
                ? 'bg-blue-500 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
            }`}
          >
            Requests
          </button>
          <button
            onClick={() => setView('traces')}
            className={`px-4 py-2 rounded-md ${
              view === 'traces'
                ? 'bg-blue-500 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
            }`}
          >
            Traces
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Total</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {totalRequests}
              </p>
            </div>
            <Activity className="w-8 h-8 text-blue-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Success Rate</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {successRate.toFixed(1)}%
              </p>
            </div>
            <Zap className="w-8 h-8 text-green-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Errors</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {errorCount}
              </p>
            </div>
            <Activity className="w-8 h-8 text-red-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Avg Latency</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {avgLatency.toFixed(0)}ms
              </p>
            </div>
            <Clock className="w-8 h-8 text-yellow-500" />
          </div>
        </div>
      </div>

      {/* Timeline Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Last 60 Seconds
        </h2>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={timelineData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Area type="monotone" dataKey="requests" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} />
            <Area type="monotone" dataKey="errors" stroke="#ef4444" fill="#ef4444" fillOpacity={0.3} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Model Stats */}
      {chartData.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            By Model
          </h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="model" angle={-45} textAnchor="end" height={100} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="count" stroke="#3b82f6" name="Requests" />
              <Line type="monotone" dataKey="errors" stroke="#ef4444" name="Errors" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Recent Activity Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Recent Activity (Last {data.length})
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Time
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Model
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Platform
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Status
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Latency
                </th>
                {view === 'requests' && (
                  <>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Input Tokens
                    </th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Output Tokens
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
              {data.slice(0, 50).map((item: any, idx: number) => (
                <tr key={item.id || idx} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="px-4 py-2 text-sm text-gray-500">
                    {new Date(item.created_at).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-900 dark:text-white">
                    {item.model_id}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                    {item.platform}
                  </td>
                  <td className="px-4 py-2 text-sm">
                    <span
                      className={`px-2 py-1 rounded-full text-xs ${
                        item.status === 'success'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-right text-gray-500">
                    {item.latency_ms ? `${item.latency_ms}ms` : '-'}
                  </td>
                  {view === 'requests' && (
                    <>
                      <td className="px-4 py-2 text-sm text-right text-gray-500">
                        {item.input_tokens || 0}
                      </td>
                      <td className="px-4 py-2 text-sm text-right text-gray-500">
                        {item.output_tokens || 0}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
