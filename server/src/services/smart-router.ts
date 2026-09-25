import { RouterRegistry, getActiveRegistry, type ModelRecord, type CredentialRecord, type ProviderRecord } from './router-registry.js';
import { analyticsAggregator } from './analytics-aggregator.js';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolDefinition,
  ChatToolChoice,
} from '@freellmapi/shared/types.js';
import type { CompletionOptions } from '../providers/base.js';

export interface RoutingRequirements {
  requestedModel?: string;
  messages: ChatMessage[];
  streaming: boolean;
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
  parallelToolCalls?: boolean;
  vision: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface CandidateRoute {
  model: ModelRecord;
  provider: ProviderRecord;
  credential: CredentialRecord;
  score: number;
}

export class SmartRouterError extends Error {
  status: number;
  code: string;
  details?: any;

  constructor(message: string, status: number, code: string, details?: any) {
    super(message);
    this.name = 'SmartRouterError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Normalizes incoming OpenAI-compatible request into explicit routing requirements.
 */
export function normalizeRoutingRequirements(body: any): RoutingRequirements {
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  
  // Check for vision/images in messages
  let vision = false;
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block === 'object' && block !== null) {
          if (block.type === 'image_url' || block.type === 'image' || (block as any).image_url) {
            vision = true;
            break;
          }
        }
      }
    }
  }

  const tools = Array.isArray(body?.tools) && body.tools.length > 0 ? body.tools : undefined;
  const structuredOutput = Boolean(body?.response_format);
  const reasoning = Boolean(body?.reasoning_effort || body?.thinking);
  const streaming = Boolean(body?.stream);

  return {
    requestedModel: body?.model?.trim(),
    messages,
    streaming,
    tools,
    toolChoice: body?.tool_choice,
    parallelToolCalls: body?.parallel_tool_calls,
    vision,
    structuredOutput,
    reasoning,
    temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
    maxTokens: typeof body?.max_tokens === 'number' ? body.max_tokens : undefined,
  };
}

/**
 * Finds and ranks candidates in memory without touching PostgreSQL.
 */
export function selectCandidates(
  a: RoutingRequirements | RouterRegistry,
  b?: RoutingRequirements | RouterRegistry
): CandidateRoute[] {
  let req: RoutingRequirements;
  let customRegistry: RouterRegistry | undefined;

  if (a instanceof RouterRegistry || (a && typeof (a as any).findCandidateModels === 'function')) {
    customRegistry = a as RouterRegistry;
    req = (b || {}) as RoutingRequirements;
  } else {
    req = (a || {}) as RoutingRequirements;
    customRegistry = b as RouterRegistry | undefined;
  }

  const registry = customRegistry || getActiveRegistry();
  const candidateModels = registry.findCandidateModels(req.requestedModel);

  if (candidateModels.length === 0) {
    throw new SmartRouterError(
      `Model '${req.requestedModel || 'auto'}' is not available or disabled.`,
      404,
      'MODEL_NOT_FOUND'
    );
  }

  // 1. Capability Filtering (Strict: NO silent capability downgrade!)
  const capableModels = candidateModels.filter(m => {
    if (req.streaming && !m.capabilities.streaming) return false;
    if (req.tools && !m.capabilities.tools) return false;
    if (req.vision && !m.capabilities.vision) return false;
    if (req.structuredOutput && !m.capabilities.structuredOutput) return false;
    if (req.reasoning && !m.capabilities.reasoning) return false;
    return true;
  });

  if (capableModels.length === 0) {
    const requiredCaps: string[] = [];
    if (req.tools) requiredCaps.push('tools');
    if (req.vision) requiredCaps.push('vision');
    if (req.structuredOutput) requiredCaps.push('structured_output');
    if (req.reasoning) requiredCaps.push('reasoning');
    if (req.streaming) requiredCaps.push('streaming');

    throw new SmartRouterError(
      `No capable provider available satisfying required capabilities: [${requiredCaps.join(', ')}].`,
      400,
      'NO_CAPABLE_PROVIDER'
    );
  }

  const now = Date.now();
  const routes: CandidateRoute[] = [];

  for (const model of capableModels) {
    const provider = registry.getProviderById(model.providerId);
    if (!provider || !provider.enabled) {
      continue;
    }

    const credentials = registry.getCredentialsForProvider(model.providerId);
    for (const cred of credentials) {
      if (!cred.enabled) continue;

      // Cooldown check
      if (cred.runtime && cred.runtime.cooldownUntil > now) {
        continue;
      }

      // Model scope check (if key is restricted to certain models)
      if (cred.modelScope && cred.modelScope.length > 0) {
        if (!cred.modelScope.includes(model.modelId) && !cred.modelScope.includes(model.canonicalName)) {
          continue;
        }
      }

      // Compute multi-factor deterministic score
      const score = computeRouteScore(model, provider, cred);
      routes.push({
        model,
        provider,
        credential: cred,
        score,
      });
    }
  }

  if (routes.length === 0) {
    throw new SmartRouterError(
      'All matching providers/credentials are currently on cooldown, rate-limited, or disabled.',
      429,
      'ALL_PROVIDERS_COOLDOWN'
    );
  }

  // Rank routes in descending score order
  routes.sort((a, b) => b.score - a.score);
  return routes;
}

export const matchModelImplementations = selectCandidates;

/**
 * Deterministic scoring function combining reliability, EWMA latency, concurrency, and priority.
 */
export function computeRouteScore(model: ModelRecord, provider: ProviderRecord, cred: CredentialRecord): number {
  const rt = cred.runtime || ({} as any);

  // 1. Reliability (Beta posterior expected value)
  const successes = Number(rt.rollingSuccessCount ?? 0);
  const failures = Number(rt.rollingFailureCount ?? 0);
  const alpha = successes + 1;
  const beta = failures + 1;
  const reliability = alpha / (alpha + beta); // 0.0 to 1.0

  // 2. Latency score (normalized: 100ms -> ~1.0, 5000ms -> ~0.0)
  const latency = Math.max(50, Number(rt.ewmaLatencyMs ?? 350));
  const latencyScore = Math.max(0.01, Math.min(1.0, 1000 / latency));

  // 3. Concurrency penalty
  const activeRequests = Number(rt.activeRequests ?? 0);
  const concurrencyPenalty = 1 / (1 + (activeRequests * 0.5));

  // 4. Rate-limit penalty (recent 429s)
  const rateLimitCount = Number(rt.rolling429Count ?? 0);
  const rateLimitFactor = rateLimitCount > 0 ? 0.7 : 1.0;

  // 5. Configured priorities
  const pPri = Number(provider.priority ?? 0);
  const mPri = Number(model.priority ?? 0);
  const cPri = Number(cred.priority ?? 0);
  const priorityBoost = 1.0 + ((pPri + mPri + cPri) * 0.05);

  // Composite score
  return (reliability * 0.4 + latencyScore * 0.4 + concurrencyPenalty * 0.2) * rateLimitFactor * priorityBoost;
}

/**
 * Executes chat completion request with concurrency management, retry backoff, and fallback loop.
 */
export async function executeChatCompletion(
  req: RoutingRequirements,
  options?: CompletionOptions
): Promise<ChatCompletionResponse> {
  const candidates = selectCandidates(req);
  const maxRetries = getActiveRegistry().getConfig().limits.maxRetries || 2;
  const maxAttempts = Math.min(candidates.length, maxRetries + 1);

  let lastError: any = null;
  let fallbackCount = 0;

  for (let i = 0; i < maxAttempts; i++) {
    const route = candidates[i];
    const { model, provider, credential } = route;
    const adapter = provider.adapter!;

    const startTime = Date.now();
    credential.runtime.activeRequests++;

    try {
      const response = await adapter.chatCompletion(
        credential.decryptedKey,
        req.messages,
        model.modelId,
        {
          ...options,
          model: model.modelId,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          tools: req.tools,
          tool_choice: req.toolChoice,
          parallel_tool_calls: req.parallelToolCalls,
        }
      );

      const latencyMs = Date.now() - startTime;

      // Update in-memory runtime health
      credential.runtime.ewmaLatencyMs = Math.round(0.8 * credential.runtime.ewmaLatencyMs + 0.2 * latencyMs);
      credential.runtime.rollingSuccessCount++;
      credential.runtime.lastUsedAt = Date.now();
      credential.runtime.circuitState = 'HEALTHY';

      // Record accurate telemetry (ZERO DB queries in hot path!)
      const usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      analyticsAggregator.record({
        providerId: provider.id,
        providerKey: provider.key,
        modelId: model.modelId,
        success: true,
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        latencyMs,
        fallbackCount,
      });

      // Attach routing metadata for transparency
      response._routed_via = {
        platform: provider.key as any,
        model: model.modelId,
      };

      return response;
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      lastError = err;
      fallbackCount++;

      const is429 = err?.status === 429 || (err?.message && /429|rate\s*limit|quota/i.test(err.message));
      const isTimeout = err?.status === 504 || (err?.message && /timeout/i.test(err.message));

      if (is429) {
        const cooldownMs = err?.retryAfterMs || 30000;
        credential.runtime.cooldownUntil = Date.now() + cooldownMs;
        credential.runtime.circuitState = 'COOLDOWN';
        credential.runtime.rolling429Count++;
      } else {
        credential.runtime.rollingFailureCount++;
        credential.runtime.circuitState = 'DEGRADED';
      }

      credential.runtime.lastFailedAt = Date.now();

      // Record error telemetry
      analyticsAggregator.record({
        providerId: provider.id,
        providerKey: provider.key,
        modelId: model.modelId,
        success: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencyMs,
        isRateLimit: is429,
        isTimeout,
        fallbackCount,
      });

      // If error is clearly non-retryable user input error (e.g. 400 Bad Request), fail immediately
      if (err?.status === 400 && !/model|quota/i.test(err.message)) {
        throw new SmartRouterError(err.message || 'Invalid request', 400, 'INVALID_REQUEST');
      }

      // If retryable, continue loop to next candidate
      console.warn(`[smart-router] Route ${provider.key}/${model.modelId} failed (attempt ${i + 1}/${maxAttempts}):`, err?.message || err);
    } finally {
      credential.runtime.activeRequests = Math.max(0, credential.runtime.activeRequests - 1);
    }
  }

  throw new SmartRouterError(
    `All available providers exhausted after ${maxAttempts} attempts. Last error: ${lastError?.message || 'Unknown error'}`,
    lastError?.status || 502,
    'ALL_PROVIDERS_EXHAUSTED',
    { lastError: lastError?.message }
  );
}

/**
 * Executes streaming chat completion with first-class streaming and token observation.
 */
export async function* executeStreamChatCompletion(
  req: RoutingRequirements,
  options?: CompletionOptions
): AsyncGenerator<ChatCompletionChunk> {
  const candidates = selectCandidates(req);
  const maxRetries = getActiveRegistry().getConfig().limits.maxRetries || 2;
  const maxAttempts = Math.min(candidates.length, maxRetries + 1);

  let lastError: any = null;
  let fallbackCount = 0;

  for (let i = 0; i < maxAttempts; i++) {
    const route = candidates[i];
    const { model, provider, credential } = route;
    const adapter = provider.adapter!;

    const startTime = Date.now();
    credential.runtime.activeRequests++;

    let streamStarted = false;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    try {
      const generator = adapter.streamChatCompletion(
        credential.decryptedKey,
        req.messages,
        model.modelId,
        {
          ...options,
          model: model.modelId,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          tools: req.tools,
          tool_choice: req.toolChoice,
          parallel_tool_calls: req.parallelToolCalls,
        }
      );

      for await (const chunk of generator) {
        streamStarted = true;
        if (chunk.usage) {
          totalPromptTokens = chunk.usage.prompt_tokens || totalPromptTokens;
          totalCompletionTokens = chunk.usage.completion_tokens || totalCompletionTokens;
        }
        yield chunk;
      }

      const latencyMs = Date.now() - startTime;
      credential.runtime.ewmaLatencyMs = Math.round(0.8 * credential.runtime.ewmaLatencyMs + 0.2 * latencyMs);
      credential.runtime.rollingSuccessCount++;
      credential.runtime.lastUsedAt = Date.now();
      credential.runtime.circuitState = 'HEALTHY';

      analyticsAggregator.record({
        providerId: provider.id,
        providerKey: provider.key,
        modelId: model.modelId,
        success: true,
        inputTokens: totalPromptTokens,
        outputTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        latencyMs,
        fallbackCount,
      });

      return;
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      lastError = err;
      fallbackCount++;

      // If stream already started delivering bytes to client, cannot transparently fallback
      if (streamStarted) {
        credential.runtime.activeRequests = Math.max(0, credential.runtime.activeRequests - 1);
        throw err;
      }

      const is429 = err?.status === 429 || (err?.message && /429|rate\s*limit|quota/i.test(err.message));
      const isTimeout = err?.status === 504 || (err?.message && /timeout/i.test(err.message));

      if (is429) {
        const cooldownMs = err?.retryAfterMs || 30000;
        credential.runtime.cooldownUntil = Date.now() + cooldownMs;
        credential.runtime.circuitState = 'COOLDOWN';
        credential.runtime.rolling429Count++;
      } else {
        credential.runtime.rollingFailureCount++;
        credential.runtime.circuitState = 'DEGRADED';
      }

      credential.runtime.lastFailedAt = Date.now();

      analyticsAggregator.record({
        providerId: provider.id,
        providerKey: provider.key,
        modelId: model.modelId,
        success: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencyMs,
        isRateLimit: is429,
        isTimeout,
        fallbackCount,
      });

      console.warn(`[smart-router] Stream route ${provider.key}/${model.modelId} failed:`, err?.message || err);
    } finally {
      credential.runtime.activeRequests = Math.max(0, credential.runtime.activeRequests - 1);
    }
  }

  throw new SmartRouterError(
    `All streaming providers exhausted. Last error: ${lastError?.message || 'Unknown error'}`,
    lastError?.status || 502,
    'ALL_PROVIDERS_EXHAUSTED',
    { lastError: lastError?.message }
  );
}
