import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

interface ClientAnalytics {
  clientAgent: string
  requests: number
  lastSeenAt: string | null
}

const analyticsIds: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  cline: 'cline',
  continue: 'continue',
  aider: 'aider',
  opencode: 'opencode',
  goose: 'goose',
  qwen: 'qwen-code',
  roo: 'roo',
  kilo: 'kilo-code',
  crush: 'crush',
  dsh: 'deepseek-harness',
  mimo: 'mimo-code',
  atomcode: 'atomcode',
  openclaw: 'openclaw',
  hermes: 'hermes-agent',
  pi: 'pi',
  reasonix: 'reasonix',
  zcode: 'zcode',
  zero: 'zero',
  cursor: 'cursor',
}

export function useRecentAgents() {
  const { data: byClient = [] } = useQuery<ClientAnalytics[]>({
    queryKey: ['analytics', 'by-client', '30d'],
    queryFn: () => apiFetch('/api/analytics/by-client?range=30d'),
  })
  // "Seen recently" means traffic within the last 7 days, not merely any row
  // in the fetched 30-day window.
  const seenCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const seen = new Map(byClient
    .filter(row => row.lastSeenAt && Date.parse(row.lastSeenAt) >= seenCutoff)
    .map(row => [row.clientAgent, row]))
  return (id: string) => seen.get(analyticsIds[id] ?? id)
}
