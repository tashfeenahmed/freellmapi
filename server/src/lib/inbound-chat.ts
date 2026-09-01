import type { Request, Response } from 'express';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';
import {
  routeRequest,
  resolveStickyPreference,
  routingReserveTokens,
  resolveModelGroupCandidates,
  type ChainRow,
  type RouteResult,
} from '../services/router.js';
import {
  getModelGroups,
  isUnifyEnabled,
  resolveRequestedIdForDispatch,
} from '../services/model-groups.js';
import {
  newFallbackState,
  recordUpstreamSuccess,
  runFallbackLoop,
  setExhaustionHeaders,
  setFallbackHeaders,
  type AttemptRecord,
  type ExhaustionBody,
} from './fallback-loop.js';
import { routedViaValue } from './header-value.js';
import { applyTokenBudget, tokenBudgetMessage } from './guardrails.js';
import { contentToString } from './content.js';
import { normalizeMessageImages } from './image-normalize.js';
import { repairToolArguments, toolSchemaMap } from './tool-args.js';
import { invalidToolArgumentsError, invalidToolCallReasons, isToolArgumentValidationEnabled } from './tool-validate.js';
import {
  containsDialectMarker,
  couldBecomeDialectMarker,
  rescueInlineToolCalls,
  startsWithDialectMarker,
} from './tool-call-rescue.js';
import { sanitizeProviderErrorMessage } from './error-redaction.js';
import { newClientAbortError, isUpstreamClassificationOutput } from './error-classify.js';
import { logRequest } from './request-log.js';
import { getStickyModel, setStickyModel } from '../routes/proxy.js';
import type { CompletionOptions } from '../providers/base.js';

export interface InboundChatRequest {
  model?: string;
  messages: ChatMessage[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
  parallelToolCalls?: boolean;
  topK?: number;
  responseFormat?: CompletionOptions['response_format'];
  reasoningEffort?: CompletionOptions['reasoning_effort'];
  sessionId?: string;
  endpoint: string;
}

export interface InboundChatResult {
  route: RouteResult;
  text: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

export interface InboundChatWire {
  sendError(res: Response, status: number, message: string, code?: string): void;
  sendNonStream(res: Response, result: InboundChatResult): void;
  startStream(res: Response, route: RouteResult): void;
  sendTextDelta(res: Response, route: RouteResult, text: string): void;
  sendReasoningDelta?(res: Response, route: RouteResult, text: string): void;
  sendToolCalls?(res: Response, route: RouteResult, calls: ChatToolCall[]): void;
  finishStream(res: Response, result: InboundChatResult): void;
  sendStreamError?(res: Response, message: string): void;
}

function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    const text = contentToString(message.content);
    const calls = (message.tool_calls ?? [])
      .reduce((n, call) => n + call.function.name.length + call.function.arguments.length, 0);
    return sum + Math.ceil((text.length + calls) / 4);
  }, 0);
}

function hasImages(messages: ChatMessage[]): boolean {
  return messages.some(message =>
    Array.isArray(message.content)
    && message.content.some(block =>
      !!block && typeof block === 'object' && (block as { type?: string }).type === 'image_url'));
}

interface ResolvedPin {
  preferredModel?: number;
  strictChain?: ChainRow[];
  pinnedLabel: string | null;
}

function resolvePin(model: string | undefined, messages: ChatMessage[], sessionId?: string): ResolvedPin {
  const requested = model?.trim();
  const auto = !requested || requested.toLowerCase() === 'auto' || requested.toLowerCase().startsWith('auto:');
  if (auto) {
    return {
      preferredModel: resolveStickyPreference(getStickyModel(messages, sessionId)),
      pinnedLabel: null,
    };
  }

  const db = getDb();
  const resolved = isUnifyEnabled()
    ? resolveRequestedIdForDispatch(requested, getModelGroups())
    : null;
  const members = resolved?.memberDbIds ?? null;
  if (members?.length) {
    const strictChain = resolveModelGroupCandidates(members, resolved!.demotedDbIds);
    if (strictChain.length === 0) {
      const err = new Error(`Model '${requested}' has no enabled provider with a usable key`) as Error & { status?: number; code?: string };
      err.status = 503;
      err.code = 'no_providers_configured';
      throw err;
    }
    const sticky = getStickyModel(messages, sessionId, requested);
    return {
      preferredModel: sticky != null && strictChain.some(row => row.model_db_id === sticky)
        ? sticky
        : undefined,
      strictChain,
      pinnedLabel: requested,
    };
  }

  const enabled = db.prepare(
    'SELECT id FROM models WHERE model_id = ? AND enabled = 1',
  ).get(requested) as { id: number } | undefined;
  if (!enabled) {
    const err = new Error(`Model '${requested}' is disabled or is not in the catalog`) as Error & { status?: number; code?: string };
    err.status = 404;
    err.code = 'model_not_found';
    throw err;
  }
  return { preferredModel: enabled.id, pinnedLabel: requested };
}

function sendExhaustion(
  res: Response,
  wire: InboundChatWire,
  exhaustion: ExhaustionBody,
  attempts: AttemptRecord[],
): void {
  setFallbackHeaders(res, attempts.length, attempts);
  setExhaustionHeaders(res, exhaustion);
  wire.sendError(res, exhaustion.status, exhaustion.message, exhaustion.code);
}

/**
 * Provider-neutral execution for non-OpenAI inbound protocols. The protocol
 * router owns validation and wire translation; this function owns the same
 * routing, retry, cooldown, accounting, pinning, and disconnect behavior as
 * the established OpenAI/Anthropic/Responses surfaces.
 */
export async function runInboundChat(
  req: Request,
  res: Response,
  input: InboundChatRequest,
  wire: InboundChatWire,
): Promise<void> {
  const start = Date.now();
  // Downscale over-threshold inline images BEFORE estimation and routing so
  // token budgets, payload limits, and upstream transfers all see the shrunk
  // bytes (see lib/image-normalize.ts). Mutates the image blocks in place.
  await normalizeMessageImages(input.messages);
  const estimatedInputTokens = estimateTokens(input.messages);
  const budget = applyTokenBudget(estimatedInputTokens, input.maxTokens);
  if (budget.rejection) {
    wire.sendError(res, 413, tokenBudgetMessage(budget.rejection), 'request_token_budget');
    return;
  }
  const maxTokens = input.maxTokens
    ?? (budget.maxTokens != null ? Math.min(1024, budget.maxTokens) : 1024);

  let pin: ResolvedPin;
  try {
    pin = resolvePin(input.model, input.messages, input.sessionId);
  } catch (error: any) {
    wire.sendError(res, error.status ?? 404, error.message, error.code ?? 'model_not_found');
    return;
  }

  const state = newFallbackState();
  const attemptLog: AttemptRecord[] = [];
  const wantsTools = (input.tools?.length ?? 0) > 0;
  const imageRequest = hasImages(input.messages);
  // Capped reserve (#470); threaded to the router separately because it is an
  // exact count and must not be inflated by the context-window safety margin
  // (#956 review).
  const outputReserve = routingReserveTokens(maxTokens);
  const estimatedTotal = estimatedInputTokens + outputReserve;
  const schemas = toolSchemaMap(input.tools);
  let clientGone = false;
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clientAbort.abort(newClientAbortError());
    }
  });

  const options: CompletionOptions = {
    temperature: input.temperature,
    max_tokens: maxTokens,
    top_p: input.topP,
    top_k: input.topK,
    stop: input.stop,
    tools: input.tools,
    tool_choice: input.toolChoice,
    parallel_tool_calls: input.parallelToolCalls,
    response_format: input.responseFormat,
    reasoning_effort: input.reasoningEffort,
    signal: clientAbort.signal,
  };

  await runFallbackLoop({
    state,
    attemptLog,
    clientGone: () => clientGone,
    route: () => routeRequest(
      estimatedTotal,
      state.skipKeys.size ? state.skipKeys : undefined,
      pin.preferredModel,
      imageRequest,
      wantsTools,
      state.skipModels.size ? state.skipModels : undefined,
      pin.strictChain,
      input.responseFormat !== undefined,
      state.skipPlatforms.size ? state.skipPlatforms : undefined,
      outputReserve,
    ),
    dispatch: async (route, attempt) => {
      if (!input.stream) {
        const result = await route.provider.chatCompletion(
          route.apiKey,
          input.messages,
          route.modelId,
          options,
        );
        const message = result.choices?.[0]?.message;
        let text = contentToString(message?.content ?? '');
        const reasoning = message?.reasoning_content ?? '';
        let toolCalls = message?.tool_calls ?? [];
        if (!text && !reasoning && toolCalls.length === 0) {
          throw Object.assign(
            new Error(`empty completion from ${route.displayName}`),
            result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
          );
        }
        // #809: a bare "safe"/"unsafe" classification word from a relay is an
        // upstream filter, not the requested model — fail over like an empty
        // completion.
        if (isUpstreamClassificationOutput(text, route.platform) && toolCalls.length === 0) {
          throw Object.assign(
            new Error(`empty completion from ${route.displayName} (upstream classification output)`),
            result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
          );
        }
        if (wantsTools && text && toolCalls.length === 0) {
          const rescue = rescueInlineToolCalls(
            text,
            new Set((input.tools ?? []).map(tool => tool.function.name)),
          );
          if (rescue.detected && !rescue.calls) {
            throw new Error(`unparseable inline tool-call dialect from ${route.displayName}`);
          }
          if (rescue.detected && rescue.calls) {
            toolCalls = rescue.calls.map((call, index) => ({
              id: `call_${Date.now()}_${index}`,
              type: 'function' as const,
              function: {
                name: call.name,
                arguments: repairToolArguments(
                  call.arguments,
                  schemas.get(call.name),
                ),
              },
            }));
            text = rescue.cleanText;
          }
        }
        for (const call of toolCalls) {
          call.function.arguments = repairToolArguments(
            call.function.arguments,
            schemas.get(call.function.name),
          );
        }
        // Opt-in schema verdict on what the repair could not fix. Nothing has
        // been written yet on this path, so the failover hop is invisible.
        if (isToolArgumentValidationEnabled() && toolCalls.length > 0) {
          const invalid = invalidToolCallReasons(toolCalls, schemas);
          if (invalid.length > 0) throw invalidToolArgumentsError(route.displayName, invalid);
        }
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens
          ?? Math.ceil((text.length + reasoning.length + toolCalls.reduce(
            (n, call) => n + call.function.name.length + call.function.arguments.length,
            0,
          )) / 4);
        const normalized: InboundChatResult = {
          route,
          text,
          reasoning,
          toolCalls,
          finishReason: result.choices?.[0]?.finish_reason ?? null,
          promptTokens,
          completionTokens,
        };
        recordUpstreamSuccess(route, result.usage?.total_tokens ?? promptTokens + completionTokens);
        if (pin.pinnedLabel == null) setStickyModel(input.messages, route.modelDbId, input.sessionId);
        res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
        setFallbackHeaders(res, attempt, attemptLog);
        logRequest(
          route.platform,
          route.modelId,
          route.keyId,
          'success',
          promptTokens,
          completionTokens,
          Date.now() - start,
          null,
          null,
          pin.pinnedLabel,
        );
        wire.sendNonStream(res, normalized);
        return 'done';
      }

      let committed = false;
      let text = '';
      let reasoning = '';
      let finishReason: string | null = null;
      let outputTokens = 0;
      const toolAcc = new Map<number, { id?: string; name: string; args: string; thoughtSignature?: string }>();
      let dialectMode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
      let heldText = '';
      const commit = () => {
        if (committed) return;
        res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
        setFallbackHeaders(res, attempt, attemptLog);
        wire.startStream(res, route);
        committed = true;
      };

      try {
        const stream = route.provider.streamChatCompletion(
          route.apiKey,
          input.messages,
          route.modelId,
          options,
        );
        for await (const chunk of stream) {
          if (clientGone) break;
          const anyChunk = chunk as Record<string, any>;
          if (anyChunk.error && !anyChunk.choices) {
            throw new Error(anyChunk.error.message ?? `in-band provider error from ${route.displayName}`);
          }
          const choice = anyChunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const deltaText = typeof choice.delta?.content === 'string' ? choice.delta.content : '';
          const deltaReasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
          if (deltaText) {
            text += deltaText;
            outputTokens += Math.ceil(deltaText.length / 4);
            if (!wantsTools || dialectMode === 'passthrough') {
              commit();
              wire.sendTextDelta(res, route, deltaText);
            } else {
              heldText += deltaText;
              const probe = heldText.trimStart();
              if (startsWithDialectMarker(probe)) {
                dialectMode = 'dialect';
              } else if (!couldBecomeDialectMarker(probe) || heldText.length > 256) {
                dialectMode = 'passthrough';
                commit();
                wire.sendTextDelta(res, route, heldText);
                heldText = '';
              }
            }
          }
          if (typeof deltaReasoning === 'string' && deltaReasoning) {
            commit();
            reasoning += deltaReasoning;
            outputTokens += Math.ceil(deltaReasoning.length / 4);
            wire.sendReasoningDelta?.(res, route, deltaReasoning);
          }
          for (const call of choice.delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            const acc = toolAcc.get(index) ?? { name: '', args: '' };
            if (call.id && !acc.id) acc.id = call.id;
            if (call.function?.name) acc.name += call.function.name;
            if (call.function?.arguments) acc.args += call.function.arguments;
            const signature = call.thought_signature ?? call.thoughtSignature;
            if (typeof signature === 'string' && !acc.thoughtSignature) acc.thoughtSignature = signature;
            toolAcc.set(index, acc);
          }
        }

        if (heldText) {
          const rescue = (dialectMode === 'dialect' || containsDialectMarker(heldText))
            ? rescueInlineToolCalls(
              heldText,
              new Set((input.tools ?? []).map(tool => tool.function.name)),
            )
            : { detected: false as const, calls: null, cleanText: heldText };
          if (rescue.detected && !rescue.calls) {
            throw new Error(`unparseable inline tool-call dialect from ${route.displayName}`);
          }
          if (rescue.detected && rescue.calls) {
            text = text.slice(0, Math.max(0, text.length - heldText.length)) + rescue.cleanText;
            if (rescue.cleanText) {
              commit();
              wire.sendTextDelta(res, route, rescue.cleanText);
            }
            rescue.calls.forEach((call, index) => {
              toolAcc.set(10_000 + index, {
                name: call.name,
                args: call.arguments,
              });
            });
          } else {
            commit();
            wire.sendTextDelta(res, route, heldText);
          }
          heldText = '';
        }

        const toolCalls: ChatToolCall[] = [...toolAcc.values()]
          .filter(call => call.name)
          .map((call, index) => ({
            id: call.id || `call_${Date.now()}_${index}`,
            type: 'function' as const,
            function: {
              name: call.name,
              arguments: repairToolArguments(call.args || '{}', schemas.get(call.name)),
            },
            ...(call.thoughtSignature ? { thought_signature: call.thoughtSignature } : {}),
          }));
        // Opt-in schema verdict, before the tool calls are committed. Tool
        // calls are buffered to the end of the stream on this path, so a
        // tool-only turn has sent nothing yet and can still fail over. A turn
        // that already streamed text is past its commit point — leave it
        // alone rather than tearing down a stream the client is reading.
        if (isToolArgumentValidationEnabled() && toolCalls.length > 0 && !committed) {
          const invalid = invalidToolCallReasons(toolCalls, schemas);
          if (invalid.length > 0) throw invalidToolArgumentsError(route.displayName, invalid);
        }
        if (toolCalls.length) {
          commit();
          wire.sendToolCalls?.(res, route, toolCalls);
          outputTokens += Math.ceil(toolCalls.reduce(
            (n, call) => n + call.function.name.length + call.function.arguments.length,
            0,
          ) / 4);
        }
        if (!text && !reasoning && toolCalls.length === 0) {
          if (clientGone) return 'committed';
          throw Object.assign(
            new Error(`empty completion from ${route.displayName}`),
            finishReason === 'length' ? { skipBench: true } : {},
          );
        }
        // #809: bare "safe"/"unsafe" classification output from a relay is an
        // upstream filter, not the requested model — fail over like an empty
        // completion.
        if (isUpstreamClassificationOutput(text, route.platform) && toolCalls.length === 0) {
          if (clientGone) return 'committed';
          throw Object.assign(
            new Error(`empty completion from ${route.displayName} (upstream classification output)`),
            finishReason === 'length' ? { skipBench: true } : {},
          );
        }

        const normalized: InboundChatResult = {
          route,
          text,
          reasoning,
          toolCalls,
          finishReason,
          promptTokens: estimatedInputTokens,
          completionTokens: outputTokens,
        };
        wire.finishStream(res, normalized);
        recordUpstreamSuccess(route, estimatedInputTokens + outputTokens);
        if (pin.pinnedLabel == null) setStickyModel(input.messages, route.modelDbId, input.sessionId);
        logRequest(
          route.platform,
          route.modelId,
          route.keyId,
          'success',
          estimatedInputTokens,
          outputTokens,
          Date.now() - start,
          null,
          null,
          pin.pinnedLabel,
        );
        return 'done';
      } catch (error: any) {
        if (!committed) throw error;
        wire.sendStreamError?.(res, sanitizeProviderErrorMessage(error.message));
        if (!res.writableEnded) res.end();
        logRequest(
          route.platform,
          route.modelId,
          route.keyId,
          'error',
          estimatedInputTokens,
          outputTokens,
          Date.now() - start,
          sanitizeProviderErrorMessage(error.message),
          null,
          pin.pinnedLabel,
        );
        return 'committed';
      }
    },
    logFailure: (route, error) => {
      logRequest(
        route.platform,
        route.modelId,
        route.keyId,
        'error',
        estimatedInputTokens,
        0,
        Date.now() - start,
        sanitizeProviderErrorMessage(error.message),
        null,
        pin.pinnedLabel,
      );
    },
    onFatal: (route, error, attempt) => {
      setFallbackHeaders(res, attempt, attemptLog);
      wire.sendError(
        res,
        502,
        `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(error.message)}`,
        'upstream_error',
      );
    },
    onRoutingExhausted: (_lastError, _routeError, exhaustion, info) => {
      sendExhaustion(res, wire, exhaustion, info.attempts);
    },
    onExhausted: (exhaustion, info) => {
      sendExhaustion(res, wire, exhaustion, info.attempts);
    },
  });
}
