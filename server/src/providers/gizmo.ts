import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';

export const GIZMO_BASE_URL = 'https://api.gizmoplatforms.com/api/v1';

function textMessages(messages: ChatMessage[], options?: CompletionOptions): ChatMessage[] {
  if (options?.tools?.length || (options?.tool_choice && options.tool_choice !== 'none')) {
    throw Object.assign(new Error('Gizmo chat supports text only, not tool calling'), { status: 400 });
  }
  if (messages.length < 1 || messages.length > 200) {
    throw Object.assign(new Error('Gizmo requires 1–200 text messages'), { status: 400 });
  }
  return messages.map(message => {
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role) || message.tool_calls?.length) {
      throw Object.assign(new Error('Gizmo chat does not support tool messages'), { status: 400 });
    }
    const content = Array.isArray(message.content)
      ? message.content.every(part => typeof part === 'string' || part.type === 'text')
        ? message.content.map(part => typeof part === 'string' ? part : part.type === 'text' ? part.text : '').join('')
        : null
      : message.content;
    if (typeof content !== 'string') {
      throw Object.assign(new Error('Gizmo chat requires text content; images and audio are not supported'), { status: 400 });
    }
    // Do not leak replay metadata, names or other provider-private fields into
    // Gizmo's strict nested schema.
    return { role: message.role, content };
  });
}

/** Only the text subset is accepted by this endpoint. The signed catalog,
 * not /models discovery, selects the recurring-free :free routes. */
export class GizmoProvider extends OpenAICompatProvider {
  constructor() {
    super({ platform: 'gizmo', name: 'Gizmo', baseUrl: GIZMO_BASE_URL });
  }

  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'Gizmo key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  private textOptions(options?: CompletionOptions): CompletionOptions {
    return {
      temperature: options?.temperature, top_p: options?.top_p, stop: options?.stop,
      max_tokens: options?.max_tokens, contextBudget: options?.contextBudget,
      stream_options: options?.stream_options, timeoutMs: options?.timeoutMs, signal: options?.signal,
    };
  }

  override async chatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): Promise<ChatCompletionResponse> {
    return super.chatCompletion(apiKey, textMessages(messages, options), modelId, this.textOptions(options), quotaContext);
  }

  override async *streamChatCompletion(apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext): AsyncGenerator<ChatCompletionChunk> {
    yield* super.streamChatCompletion(apiKey, textMessages(messages, options), modelId, this.textOptions(options), quotaContext);
  }
}
