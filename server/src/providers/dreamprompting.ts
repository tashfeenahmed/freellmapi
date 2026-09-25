import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

function checkModel(requested: string, returned: string): void {
  // DreamPrompting is a fail-over router. `auto` legitimately reports
  // whichever upstream served the call. Every other route is addressed as
  // `<upstream>/<upstream model id>` and the response reports the upstream
  // id: `groq/openai/gpt-oss-20b` -> `openai/gpt-oss-20b`,
  // `codestral/codestral-latest` -> `codestral-latest`, `chat/ch.at` ->
  // `ch.at`, with any `:free` suffix dropped. Anything else is a substitution.
  if (requested === 'auto') return;
  const stripped = requested.replace(/:free$/, '');
  const unprefixed = stripped.includes('/') ? stripped.slice(stripped.indexOf('/') + 1) : stripped;
  const accepted = typeof returned === 'string' && returned.length > 0 && (
    returned === requested || returned === stripped || returned === unprefixed
  );
  if (!accepted) {
    throw Object.assign(new Error('DreamPrompting returned a different or missing model identity'), { status: 502 });
  }
}

export class DreamPromptingProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'DreamPrompting key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    super({ platform: 'dreamprompting', name: 'DreamPrompting', baseUrl: 'https://dreamprompting.com/api/v1' });
  }

  override async chatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      checkModel(modelId, chunk.model);
      yield chunk;
    }
  }
}
