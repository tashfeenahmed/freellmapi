import type {
  ApiKey,
  GroupedProvider,
  Model,
  ProviderHealthStatus,
  ProviderSummary,
} from '../../../shared/types'
import { PLATFORMS, CUSTOM_GROUP } from '@/components/keys/shared'

export interface GroupProvidersOptions {
  keys: ApiKey[]
  models: Model[]
  hiddenProviderIds?: Set<string>
  hiddenModelIds?: Set<string> // composite: "platform:modelId" or "modelDbId"
}

export interface FilterProvidersOptions {
  search?: string
  statusFilter?: 'all' | 'configured' | 'healthy' | 'issues' | 'unconfigured'
  showHiddenProviders?: boolean
  showHiddenModels?: boolean
  hiddenProviderIds?: Set<string>
  hiddenModelIds?: Set<string>
}

/**
 * Calculates a provider's overall health status given its keys.
 */
export function calculateProviderHealth(
  keys: ApiKey[],
  isKeyless = false,
): ProviderHealthStatus {
  if (keys.length === 0) {
    return isKeyless ? 'healthy' : 'unconfigured'
  }

  const enabledKeys = keys.filter(k => k.enabled)
  if (enabledKeys.length === 0) {
    return 'unknown'
  }

  const hasHealthy = enabledKeys.some(k => k.status === 'healthy')
  if (hasHealthy) return 'healthy'

  const hasRateLimited = enabledKeys.some(k => k.status === 'rate_limited')
  if (hasRateLimited) return 'rate_limited'

  const hasIssues = enabledKeys.some(k => k.status === 'invalid' || k.status === 'error')
  if (hasIssues) return 'issues'

  return 'unknown'
}

/**
 * Pure function grouping keys and models into per-provider data structures.
 */
export function groupProviders(
  keys: ApiKey[],
  models: Model[],
): GroupedProvider[] {
  const providers: GroupedProvider[] = []

  // Index keys by platform
  const keysByPlatform = new Map<string, ApiKey[]>()
  for (const key of keys) {
    const list = keysByPlatform.get(key.platform) ?? []
    list.push(key)
    keysByPlatform.set(key.platform, list)
  }

  // Index models by platform
  const modelsByPlatform = new Map<string, Model[]>()
  for (const model of models) {
    const list = modelsByPlatform.get(model.platform) ?? []
    list.push(model)
    modelsByPlatform.set(model.platform, list)
  }

  // 1. Process standard catalog platforms from PLATFORMS registry
  for (const p of PLATFORMS) {
    const platformKeys = keysByPlatform.get(p.value) ?? []
    const platformModels = modelsByPlatform.get(p.value) ?? []

    const totalKeys = platformKeys.length
    const enabledKeys = platformKeys.filter(k => k.enabled).length
    const healthyKeys = platformKeys.filter(k => k.enabled && k.status === 'healthy').length
    const activeModels = platformModels.filter(m => m.enabled).length
    const totalModels = platformModels.length
    const isConfigured = totalKeys > 0 || Boolean(p.keyless)
    const status = calculateProviderHealth(platformKeys, p.keyless)

    const summary: ProviderSummary = {
      platform: p.value,
      name: p.label,
      totalKeys,
      enabledKeys,
      healthyKeys,
      totalModels,
      activeModels,
      status,
      isConfigured,
    }

    providers.push({
      id: p.value,
      platform: p.value,
      name: p.label,
      url: p.url,
      baseUrl: null,
      endpointScope: null,
      keyless: p.keyless,
      keys: platformKeys,
      models: platformModels,
      summary,
    })
  }

  // 2. Process Custom endpoints (platform === 'custom')
  const customKeys = keysByPlatform.get('custom') ?? []
  const customModels = modelsByPlatform.get('custom') ?? []

  // Group custom keys and models by baseUrl/endpoint
  const customGroups = new Map<string, { keys: ApiKey[]; models: Model[]; baseUrl: string | null }>()

  if (customKeys.length === 0 && customModels.length === 0) {
    // Show one empty custom provider card so the user can discover adding custom endpoints
    providers.push({
      id: 'custom',
      platform: 'custom',
      name: CUSTOM_GROUP.label,
      url: undefined,
      baseUrl: null,
      endpointScope: null,
      keyless: false,
      keys: [],
      models: [],
      summary: {
        platform: 'custom',
        name: CUSTOM_GROUP.label,
        totalKeys: 0,
        enabledKeys: 0,
        healthyKeys: 0,
        totalModels: 0,
        activeModels: 0,
        status: 'unconfigured',
        isConfigured: false,
      },
    })
  } else {
    for (const key of customKeys) {
      const urlKey = (key.baseUrl ?? '').trim() || 'default'
      const grp = customGroups.get(urlKey) ?? { keys: [], models: [], baseUrl: key.baseUrl }
      grp.keys.push(key)
      customGroups.set(urlKey, grp)
    }

    // Map custom models to their endpoint by keyId or endpointScope
    const keyIdToUrl = new Map<number, string>()
    for (const key of customKeys) {
      keyIdToUrl.set(key.id, (key.baseUrl ?? '').trim() || 'default')
    }

    for (const model of customModels) {
      const mAny = model as Model & { keyId?: number | null; endpointScope?: string | null }
      let urlKey = 'default'
      if (mAny.keyId && keyIdToUrl.has(mAny.keyId)) {
        urlKey = keyIdToUrl.get(mAny.keyId)!
      } else if (mAny.endpointScope) {
        urlKey = mAny.endpointScope
      }
      const grp = customGroups.get(urlKey) ?? { keys: [], models: [], baseUrl: urlKey === 'default' ? null : urlKey }
      grp.models.push(model)
      customGroups.set(urlKey, grp)
    }

    for (const [urlKey, grp] of customGroups.entries()) {
      const totalKeys = grp.keys.length
      const enabledKeys = grp.keys.filter(k => k.enabled).length
      const healthyKeys = grp.keys.filter(k => k.enabled && k.status === 'healthy').length
      const activeModels = grp.models.filter(m => m.enabled).length
      const totalModels = grp.models.length
      const isConfigured = totalKeys > 0
      const status = calculateProviderHealth(grp.keys)

      const displayName = grp.baseUrl
        ? `Custom (${grp.baseUrl})`
        : CUSTOM_GROUP.label

      const summary: ProviderSummary = {
        platform: 'custom',
        name: displayName,
        totalKeys,
        enabledKeys,
        healthyKeys,
        totalModels,
        activeModels,
        status,
        isConfigured,
      }

      providers.push({
        id: urlKey === 'default' ? 'custom' : `custom:${urlKey}`,
        platform: 'custom',
        name: displayName,
        url: undefined,
        baseUrl: grp.baseUrl,
        endpointScope: grp.baseUrl,
        keyless: false,
        keys: grp.keys,
        models: grp.models,
        summary,
      })
    }
  }

  // Sort providers: Configured first, then alphabetical by name
  return providers.sort((a, b) => {
    if (a.summary.isConfigured !== b.summary.isConfigured) {
      return a.summary.isConfigured ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
}

/**
 * Filter grouped providers by search query, status filter, and hidden state.
 */
export function filterGroupedProviders(
  providers: GroupedProvider[],
  options: FilterProvidersOptions,
): GroupedProvider[] {
  const {
    search = '',
    statusFilter = 'all',
    showHiddenProviders = false,
    showHiddenModels = false,
    hiddenProviderIds = new Set(),
    hiddenModelIds = new Set(),
  } = options

  const query = search.trim().toLowerCase()

  return providers
    .filter(provider => {
      // Hidden provider filter
      if (!showHiddenProviders && hiddenProviderIds.has(provider.id)) {
        return false
      }

      // Status filter
      if (statusFilter === 'configured' && !provider.summary.isConfigured) {
        return false
      }
      if (statusFilter === 'unconfigured' && provider.summary.isConfigured) {
        return false
      }
      if (statusFilter === 'healthy' && provider.summary.status !== 'healthy') {
        return false
      }
      if (statusFilter === 'issues' && provider.summary.status !== 'issues' && provider.summary.status !== 'rate_limited') {
        return false
      }

      // Search matching provider name
      if (!query) return true

      const nameMatch = provider.name.toLowerCase().includes(query)
      if (nameMatch) return true

      const keyMatch = provider.keys.some(k =>
        (k.label && k.label.toLowerCase().includes(query)) ||
        (k.maskedKey && k.maskedKey.toLowerCase().includes(query))
      )
      if (keyMatch) return true

      const modelMatch = provider.models.some(m =>
        m.modelId.toLowerCase().includes(query) ||
        m.displayName.toLowerCase().includes(query)
      )
      if (modelMatch) return true

      return false
    })
    .map(provider => {
      // Filter hidden models inside the provider if requested
      if (showHiddenModels || hiddenModelIds.size === 0) {
        return provider
      }

      const visibleModels = provider.models.filter(m => !hiddenModelIds.has(`${provider.platform}:${m.modelId}`) && !hiddenModelIds.has(String(m.id)))
      return {
        ...provider,
        models: visibleModels,
        summary: {
          ...provider.summary,
          totalModels: visibleModels.length,
          activeModels: visibleModels.filter(m => m.enabled).length,
        },
      }
    })
}

// ── UI State Storage in localStorage ─────────────────────────────────────────

const HIDDEN_PROVIDERS_KEY = 'freellmapi.providers.hidden'
const HIDDEN_MODELS_KEY = 'freellmapi.models.hidden'
const COLLAPSED_PROVIDERS_KEY = 'freellmapi.providers.collapsed'

export function getHiddenProviders(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_PROVIDERS_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function setHiddenProviders(ids: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_PROVIDERS_KEY, JSON.stringify([...ids]))
  } catch {
    // localStorage full or disabled
  }
}

export function getHiddenModels(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_MODELS_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function setHiddenModels(ids: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...ids]))
  } catch {
    // localStorage full or disabled
  }
}

export function getCollapsedProviders(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_PROVIDERS_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

export function setCollapsedProviders(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PROVIDERS_KEY, JSON.stringify([...ids]))
  } catch {
    // localStorage full or disabled
  }
}
