import { getPostgresPool } from '../db/postgres.js';
import { decrypt, maskKey } from '../lib/crypto.js';
import { getProvider, hasProvider } from '../providers/index.js';
import type { BaseProvider } from '../providers/base.js';
import type { Platform } from '@freellmapi/shared/types.js';

export interface ProviderRecord {
  id: number;
  key: string;
  displayName: string;
  baseUrl: string | null;
  enabled: boolean;
  priority: number;
  adapter?: BaseProvider;
}

export type CircuitState = 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'DISABLED';

export interface CredentialRuntimeState {
  activeRequests: number;
  cooldownUntil: number;
  circuitState: CircuitState;
  ewmaLatencyMs: number;
  rollingSuccessCount: number;
  rollingFailureCount: number;
  rolling429Count: number;
  lastUsedAt: number | null;
  lastFailedAt: number | null;
  lastHealthError: string | null;
}

export interface CredentialRecord {
  id: number;
  providerId: number;
  providerKey: string;
  name: string;
  decryptedKey: string;
  maskedKey: string;
  credentialType: string;
  enabled: boolean;
  priority: number;
  modelScope: string[] | null;
  runtime: CredentialRuntimeState;
}

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
}

export interface ModelRecord {
  id: number;
  providerId: number;
  providerKey: string;
  modelId: string;
  canonicalName: string;
  displayName: string;
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: ModelCapabilities;
  inputPrice: number;
  outputPrice: number;
  priority: number;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
}

export interface RoutingConfiguration {
  strategy: string;
  explorationRate: number;
  weights: {
    speed: number;
    intelligence: number;
    reliability: number;
  };
  limits: {
    maxRetries: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
  };
}

export class RouterRegistry {
  private providersById = new Map<number, ProviderRecord>();
  private providersByKey = new Map<string, ProviderRecord>();
  private credentialsById = new Map<number, CredentialRecord>();
  private credentialsByProviderId = new Map<number, CredentialRecord[]>();
  private modelsById = new Map<number, ModelRecord>();
  private modelsByCanonical = new Map<string, ModelRecord[]>();
  private modelsByExactId = new Map<string, ModelRecord[]>();
  private config: RoutingConfiguration = {
    strategy: 'bandit',
    explorationRate: 0.1,
    weights: { speed: 0.35, intelligence: 0.35, reliability: 0.30 },
    limits: { maxRetries: 2, baseBackoffMs: 250, maxBackoffMs: 5000 },
  };

  constructor(
    providers: ProviderRecord[],
    credentials: CredentialRecord[],
    models: ModelRecord[],
    config?: Partial<RoutingConfiguration>
  ) {
    for (const p of providers) {
      this.providersById.set(p.id, p);
      this.providersByKey.set(p.key, p);
    }

    for (const c of credentials) {
      this.credentialsById.set(c.id, c);
      const list = this.credentialsByProviderId.get(c.providerId) || [];
      list.push(c);
      this.credentialsByProviderId.set(c.providerId, list);
    }

    for (const m of models) {
      this.modelsById.set(m.id, m);

      // Map canonical
      const canonicalLower = (m.canonicalName || m.modelId || '').toLowerCase();
      if (canonicalLower) {
        const canonicalList = this.modelsByCanonical.get(canonicalLower) || [];
        canonicalList.push(m);
        this.modelsByCanonical.set(canonicalLower, canonicalList);
      }

      // Map exact model_id
      const idLower = (m.modelId || '').toLowerCase();
      if (idLower) {
        const idList = this.modelsByExactId.get(idLower) || [];
        idList.push(m);
        this.modelsByExactId.set(idLower, idList);
      }
    }

    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  getProviderById(id: number): ProviderRecord | undefined {
    return this.providersById.get(id);
  }

  getProviderByKey(key: string): ProviderRecord | undefined {
    return this.providersByKey.get(key);
  }

  getAllProviders(): ProviderRecord[] {
    return Array.from(this.providersByKey.values());
  }

  getCredentialById(id: number): CredentialRecord | undefined {
    return this.credentialsById.get(id);
  }

  getCredentialsForProvider(providerId: number): CredentialRecord[] {
    return this.credentialsByProviderId.get(providerId) || [];
  }

  getAllCredentials(): CredentialRecord[] {
    return Array.from(this.credentialsById.values());
  }

  getModelById(id: number): ModelRecord | undefined {
    return this.modelsById.get(id);
  }

  getAllModels(): ModelRecord[] {
    return Array.from(this.modelsById.values());
  }

  findCandidateModels(requestedModel?: string): ModelRecord[] {
    if (!requestedModel || requestedModel.toLowerCase() === 'auto' || requestedModel.toLowerCase().startsWith('auto:')) {
      return Array.from(this.modelsById.values()).filter(m => m.enabled);
    }

    const lower = requestedModel.toLowerCase();

    // 1. Check exact model_id match
    const exactMatches = this.modelsByExactId.get(lower);
    if (exactMatches && exactMatches.length > 0) {
      return exactMatches.filter(m => m.enabled);
    }

    // 2. Check canonical name match
    const canonicalMatches = this.modelsByCanonical.get(lower);
    if (canonicalMatches && canonicalMatches.length > 0) {
      return canonicalMatches.filter(m => m.enabled);
    }

    // 3. Fallback: fuzzy/prefix match on model ID
    const fuzzy = Array.from(this.modelsById.values()).filter(m =>
      m.enabled && (
        (m.modelId || '').toLowerCase().includes(lower) ||
        (m.canonicalName || '').toLowerCase().includes(lower)
      )
    );

    return fuzzy;
  }

  findModelCandidates(requestedModel?: string): ModelRecord[] {
    return this.findCandidateModels(requestedModel);
  }

  getConfig(): RoutingConfiguration {
    return this.config;
  }
}

let activeRegistry: RouterRegistry | null = null;
let reloadPromise: Promise<RouterRegistry> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

// Default 10 minutes refresh interval
const DEFAULT_REFRESH_INTERVAL_MS = 600000;

export function getActiveRegistry(): RouterRegistry {
  if (!activeRegistry) {
    activeRegistry = new RouterRegistry([], [], []);
  }
  return activeRegistry;
}

export function isRegistryInitialized(): boolean {
  return activeRegistry !== null;
}

/**
 * Loads durable configuration from Neon PostgreSQL and builds the in-memory routing registry.
 */
export async function reloadRoutingRegistry(): Promise<RouterRegistry> {
  if (reloadPromise) {
    await reloadPromise;
  }

  reloadPromise = (async () => {
    try {
      const pool = getPostgresPool();

      // 1. Fetch providers
      const providerRows = await pool.query(`
        SELECT id, provider_key, display_name, base_url, enabled, priority
        FROM providers
        ORDER BY priority DESC, id ASC
      `);

      const providers: ProviderRecord[] = providerRows.rows.map((row: any) => ({
        id: row.id,
        key: row.provider_key,
        displayName: row.display_name,
        baseUrl: row.base_url,
        enabled: row.enabled,
        priority: row.priority || 0,
        adapter: hasProvider(row.provider_key as Platform) ? getProvider(row.provider_key as Platform) : undefined,
      }));

      // Map provider ID to key
      const providerKeyMap = new Map<number, string>();
      for (const p of providers) {
        providerKeyMap.set(p.id, p.key);
      }

      // 2. Fetch credentials
      const credRows = await pool.query(`
        SELECT id, provider_id, credential_name, encrypted_value, iv, auth_tag,
               credential_type, enabled, priority, cooldown_until, model_scope,
               last_health_error
        FROM credentials
        ORDER BY priority DESC, id ASC
      `);

      const credentials: CredentialRecord[] = [];
      const now = Date.now();

      for (const row of credRows.rows) {
        let decrypted = '';
        let decryptFailed = false;
        try {
          decrypted = decrypt(row.encrypted_value, row.iv, row.auth_tag);
        } catch {
          decrypted = '';
          decryptFailed = true;
        }

        const providerKey = providerKeyMap.get(row.provider_id) || 'unknown';
        const cooldownUntilMs = row.cooldown_until ? new Date(row.cooldown_until).getTime() : 0;
        const isOnCd = cooldownUntilMs > now;
        const isUsable = Boolean(row.enabled) && !decryptFailed && Boolean(decrypted);

        // Preserve previous in-memory runtime telemetry if credential existed in previous registry
        const existingCred = activeRegistry?.getCredentialById(row.id);

        const runtimeState: CredentialRuntimeState = existingCred
          ? {
              ...existingCred.runtime,
              cooldownUntil: Math.max(cooldownUntilMs, existingCred.runtime.cooldownUntil),
              circuitState: !isUsable ? 'DISABLED' : (isOnCd ? 'COOLDOWN' : existingCred.runtime.circuitState),
              lastHealthError: decryptFailed ? 'Decryption failed' : (row.last_health_error || existingCred.runtime.lastHealthError),
            }
          : {
              activeRequests: 0,
              cooldownUntil: cooldownUntilMs,
              circuitState: !isUsable ? 'DISABLED' : (isOnCd ? 'COOLDOWN' : 'HEALTHY'),
              ewmaLatencyMs: 350,
              rollingSuccessCount: 0,
              rollingFailureCount: 0,
              rolling429Count: 0,
              lastUsedAt: null,
              lastFailedAt: null,
              lastHealthError: decryptFailed ? 'Decryption failed' : (row.last_health_error || null),
            };

        credentials.push({
          id: row.id,
          providerId: row.provider_id,
          providerKey,
          name: row.credential_name || '',
          decryptedKey: decrypted,
          maskedKey: maskKey(decrypted),
          credentialType: row.credential_type || 'api_key',
          enabled: isUsable,
          priority: row.priority || 0,
          modelScope: row.model_scope
            ? (Array.isArray(row.model_scope)
                ? row.model_scope
                : (typeof row.model_scope === 'string' && row.model_scope.startsWith('[')
                    ? JSON.parse(row.model_scope)
                    : null))
            : null,
          runtime: runtimeState,
        });
      }

      // 3. Fetch models
      const modelRows = await pool.query(`
        SELECT id, provider_id, model_id, canonical_name, display_name, enabled,
               context_window, max_output_tokens, supports_streaming, supports_tools,
               supports_vision, supports_structured_output, supports_reasoning,
               input_price, output_price, priority,
               intelligence_rank, speed_rank, size_label
        FROM models
        ORDER BY priority DESC, id ASC
      `);

      const models: ModelRecord[] = modelRows.rows.map((row: any) => ({
        id: row.id,
        providerId: row.provider_id,
        providerKey: providerKeyMap.get(row.provider_id) || 'unknown',
        modelId: row.model_id,
        canonicalName: row.canonical_name,
        displayName: row.display_name,
        enabled: row.enabled,
        contextWindow: row.context_window,
        maxOutputTokens: row.max_output_tokens,
        capabilities: {
          streaming: row.supports_streaming ?? true,
          tools: row.supports_tools ?? false,
          vision: row.supports_vision ?? false,
          structuredOutput: row.supports_structured_output ?? false,
          reasoning: row.supports_reasoning ?? false,
        },
        inputPrice: Number(row.input_price || 0),
        outputPrice: Number(row.output_price || 0),
        priority: row.priority || 0,
        intelligenceRank: row.intelligence_rank ?? 0,
        speedRank: row.speed_rank ?? 0,
        sizeLabel: row.size_label ?? '',
      }));

      // 4. Fetch routing configuration
      const configRows = await pool.query('SELECT config_key, config_value FROM routing_configuration');
      const routingConfigPartial: any = {};
      for (const row of configRows.rows) {
        if (row.config_key === 'strategy' && row.config_value) {
          routingConfigPartial.strategy = row.config_value.name || 'bandit';
          routingConfigPartial.explorationRate = row.config_value.explorationRate ?? 0.1;
        }
        if (row.config_key === 'weights' && row.config_value) {
          routingConfigPartial.weights = row.config_value;
        }
        if (row.config_key === 'limits' && row.config_value) {
          routingConfigPartial.limits = row.config_value;
        }
      }

      // Create new registry and atomically swap reference
      const newRegistry = new RouterRegistry(providers, credentials, models, routingConfigPartial);
      activeRegistry = newRegistry;
      console.log(`[router-registry] In-memory registry loaded (${providers.length} providers, ${credentials.length} credentials, ${models.length} models)`);
      return newRegistry;
    } finally {
      reloadPromise = null;
    }
  })();

  return reloadPromise;
}

/**
 * Initializes registry and starts background configuration refresh scheduler.
 */
export async function initRoutingRegistry(): Promise<RouterRegistry> {
  const registry = await reloadRoutingRegistry();

  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  const refreshInterval = Number(process.env.ROUTER_CONFIG_REFRESH_MS || DEFAULT_REFRESH_INTERVAL_MS);
  refreshTimer = setInterval(async () => {
    try {
      await reloadRoutingRegistry();
    } catch (err: any) {
      console.warn('[router-registry] Background configuration refresh failed (continuing with cached registry):', err?.message);
    }
  }, refreshInterval);

  if (refreshTimer.unref) {
    refreshTimer.unref();
  }

  return registry;
}

export function stopRoutingRegistryScheduler(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
