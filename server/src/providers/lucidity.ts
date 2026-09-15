import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

function checkModel(requested: string, returned: string): void {
  // Catalog routes carry a `:free` suffix that the response omits, and the
  // `lucidityai/synth-2.5-*:free` routes legitimately report the gateway's
  // own `synth-2.5-preview`. Anything else (including the `open/*` routes
  // observed silently answering as synth-2.5-preview) is a substitution.
  const accepted = typeof returned === 'string' && returned.length > 0 && (
    returned === requested ||
    returned === requested.replace(/:free$/, '') ||
    (requested.startsWith('lucidityai/synth-') && returned.startsWith('synth-'))
  );
  if (!accepted) {
    throw Object.assign(new Error('Lucidity Composite returned a different or missing model identity'), { status: 502 });
  }
}

export class LucidityProvider extends OpenAICompatProvider {
  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (!response.ok && ![401, 403].includes(response.status)) {
      throw providerHttpError(response, 'Lucidity Composite key validation is temporarily inconclusive');
    }
    return super.validationResult(response);
  }

  constructor() {
    super({ platform: 'lucidity', name: 'Lucidity Composite', baseUrl: 'https://composite.lucidity.sh/v1' });
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
