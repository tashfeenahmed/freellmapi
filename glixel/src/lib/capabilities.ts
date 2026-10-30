// What the server says GLIXEL can use. The AI path is chosen by the user and
// kept in memory only; it starts as the server's default (FreeLLMAPI), and a
// path the server reports as unavailable can never be selected.
import { apiGet } from './session'

export type ProviderChoice = 'freellmapi' | 'claude'

export interface ProviderPath {
  id: ProviderChoice
  label: string
  available: boolean
  billing: string
  reason: string | null
}

export interface Capabilities {
  providers: ProviderPath[]
  defaultProvider: ProviderChoice
  routing: {
    source: 'environment'
    freeOnly: { enabled: boolean; optedIn: Array<{ platform: string; freeTier: string; warning: string | null }> }
    fallbackMaxAttempts: number
  }
}

export const getCapabilities = () => apiGet<Capabilities>('/api/glixel/capabilities')
