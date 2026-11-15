import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { engineChain, type SearchEngine, type SearchReadiness } from '@/lib/search'

/** Local-only reads. Polling catches background catalog sync and expiring
 * cooldowns; immediate invalidation handles key and engine mutations. */
export function useSearchReadiness() {
  const engines = useQuery<SearchEngine[]>({
    queryKey: ['search-engines'], queryFn: async () => {
      const data = await apiFetch<SearchEngine[]>('/api/search/engines')
      if (!Array.isArray(data)) throw new Error('Invalid search-engine response; check that the dashboard and server are up to date.')
      return data
    },
    retry: false, staleTime: 0, refetchInterval: 30_000,
  })
  const status = useQuery<SearchReadiness>({
    queryKey: ['search-status'], queryFn: async () => {
      const data = await apiFetch<SearchReadiness>('/api/search/status')
      if (!data || !['ready', 'cooling_down', 'needs_configuration'].includes(data.status)
          || !Array.isArray(data.engines) || !Array.isArray(data.missing_from_catalog) || !data.catalog) {
        throw new Error('Invalid search-status response; check that the dashboard and server are up to date.')
      }
      return data
    },
    retry: false, staleTime: 0, refetchInterval: 30_000,
  })
  const failed = engines.isError || status.isError
  const loading = engines.isPending || status.isPending
  const readyEngines = !failed && !loading && status.data?.status === 'ready' ? engineChain(engines.data ?? []).filter(e =>
    e.healthyKeyCount > 0 && status.data?.engines.some(s => s.engine === e.engineId && s.platform === e.platform && s.state === 'ready'),
  ) : []
  return {
    engines: engines.data ?? [], data: status.data, failed, loading,
    error: engines.error ?? status.error,
    available: readyEngines.length > 0, readyEngines,
    retry: () => { void engines.refetch(); void status.refetch() },
  }
}
