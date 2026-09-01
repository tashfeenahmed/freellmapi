import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar } from 'recharts'
import { Activity, TrendingUp, Zap, Target, Wifi, WifiOff } from 'lucide-react'
import { useRealtimeScores } from '@/hooks/useRealtimeStore'

export function RoutingAnalytics() {
  const { scores, connected, strategy } = useRealtimeScores()

  // Calculate summary stats
  const totalModels = scores.length
  const enabledModels = scores.filter((s) => s.enabled).length
  const avgReliability = scores.length > 0
    ? scores.reduce((sum, s) => sum + s.reliability, 0) / scores.length
    : 0
  const avgSpeed = scores.length > 0
    ? scores.reduce((sum, s) => sum + s.speed, 0) / scores.length
    : 0
  const totalRequests = scores.reduce((sum, s) => sum + s.totalRequests, 0)

  // Top 10 models by score
  const topModels = [...scores].sort((a, b) => b.score - a.score).slice(0, 10)

  // Models with low reliability (potential issues)
  const lowReliability = scores.filter((s) => s.reliability < 0.5 && s.totalRequests > 10)

  // Prepare data for radar chart (top 5 models)
  const radarData = topModels.slice(0, 5).map((model) => ({
    model: model.displayName.substring(0, 20),
    Reliability: model.reliability * 100,
    Speed: model.speed * 100,
    Intelligence: model.intelligence * 100,
    Headroom: model.headroom * 100,
  }))

  if (scores.length === 0) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="text-gray-500 mb-2">Loading routing analytics...</div>
          <div className="text-sm text-gray-400">
            {connected ? 'Connected, waiting for data...' : 'Connecting...'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 bg-gray-50 dark:bg-gray-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Routing Analytics
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
            Strategy: <span className="font-semibold">{strategy}</span> ·{' '}
            {enabledModels}/{totalModels} models enabled
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Avg Reliability</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {(avgReliability * 100).toFixed(1)}%
              </p>
            </div>
            <Target className="w-8 h-8 text-blue-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Avg Speed</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {(avgSpeed * 100).toFixed(1)}%
              </p>
            </div>
            <Zap className="w-8 h-8 text-yellow-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Requests</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {totalRequests.toLocaleString()}
              </p>
            </div>
            <Activity className="w-8 h-8 text-green-500" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500 dark:text-gray-400">Low Reliability</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">
                {lowReliability.length}
              </p>
            </div>
            <TrendingUp className="w-8 h-8 text-red-500" />
          </div>
        </div>
      </div>

      {/* Top Models Bar Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Top 10 Models by Score
        </h2>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={topModels.map((m) => ({
            name: m.displayName.substring(0, 25),
            score: m.score,
            reliability: m.reliability,
            speed: m.speed,
          }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" angle={-45} textAnchor="end" height={100} />
            <YAxis />
            <Tooltip />
            <Legend />
            <Bar dataKey="score" fill="#3b82f6" name="Overall Score" />
            <Bar dataKey="reliability" fill="#10b981" name="Reliability" />
            <Bar dataKey="speed" fill="#f59e0b" name="Speed" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Radar Chart - Top 5 Models */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Top 5 Models - Multi-Axis Comparison
          </h2>
          <ResponsiveContainer width="100%" height={400}>
            <RadarChart data={radarData}>
              <PolarGrid />
              <PolarAngleAxis dataKey="model" />
              <PolarRadiusAxis angle={90} domain={[0, 100]} />
              <Radar name="Reliability" dataKey="Reliability" stroke="#10b981" fill="#10b981" fillOpacity={0.3} />
              <Radar name="Speed" dataKey="Speed" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.3} />
              <Radar name="Intelligence" dataKey="Intelligence" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} />
              <Radar name="Headroom" dataKey="Headroom" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.3} />
              <Legend />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Score Distribution */}
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Score Distribution
          </h2>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={[
              { range: '0-0.2', count: scores.filter(s => s.score < 0.2).length },
              { range: '0.2-0.4', count: scores.filter(s => s.score >= 0.2 && s.score < 0.4).length },
              { range: '0.4-0.6', count: scores.filter(s => s.score >= 0.4 && s.score < 0.6).length },
              { range: '0.6-0.8', count: scores.filter(s => s.score >= 0.6 && s.score < 0.8).length },
              { range: '0.8-1.0', count: scores.filter(s => s.score >= 0.8).length },
            ]}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="range" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="count" fill="#8b5cf6" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Detailed Scores Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          All Models - Detailed Scores
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Model
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Platform
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Score
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Reliability
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Speed
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Intelligence
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Headroom
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                  Requests
                </th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
              {scores.map((score) => (
                <tr key={score.modelDbId} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="px-4 py-2 text-sm text-gray-900 dark:text-white">
                    {score.displayName}
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                    {score.platform}
                  </td>
                  <td className="px-4 py-2 text-sm text-right font-mono">
                    {score.score.toFixed(3)}
                  </td>
                  <td className="px-4 py-2 text-sm text-right">
                    <span className={score.reliability < 0.5 ? 'text-red-600' : 'text-green-600'}>
                      {(score.reliability * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-right">
                    {(score.speed * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-2 text-sm text-right">
                    {(score.intelligence * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-2 text-sm text-right">
                    {(score.headroom * 100).toFixed(1)}%
                  </td>
                  <td className="px-4 py-2 text-sm text-right text-gray-500">
                    {score.totalRequests}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
