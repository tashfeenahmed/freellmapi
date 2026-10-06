import { useState } from 'react'
import { apiFetch } from '@/lib/api'
import { fetchLatestIndex, isNewBuild, loadedEntryScript } from '@/lib/new-build'

const POLL_MS = 3000
const GIVE_UP_MS = 5 * 60 * 1000

export type DockerUpdatePhase = 'idle' | 'starting' | 'waiting' | 'failed' | 'timeout'

/**
 * Docker "Update now": the server asks its Watchtower sidecar to pull the new
 * image and recreate the container (POST /api/update/apply), which takes this
 * server down mid-session. The page then polls for index.html and reloads
 * once the server is back — on a new build, or after it was seen restarting.
 */
export function useDockerUpdate() {
  const [phase, setPhase] = useState<DockerUpdatePhase>('idle')

  async function start() {
    setPhase('starting')
    try {
      await apiFetch('/api/update/apply', { method: 'POST' })
    } catch {
      setPhase('failed')
      return
    }
    setPhase('waiting')
    const loaded = loadedEntryScript()
    const started = Date.now()
    let wentDown = false
    while (Date.now() - started < GIVE_UP_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
      try {
        const html = await fetchLatestIndex()
        if (isNewBuild(loaded, html) || wentDown) {
          window.location.reload()
          return
        }
      } catch {
        wentDown = true
      }
    }
    setPhase('timeout')
  }

  return { phase, start, reset: () => setPhase('idle') }
}
