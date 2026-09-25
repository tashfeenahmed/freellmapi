import type { ChatCompletionChunk, ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import type { CompletionOptions } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { contentToString } from '../lib/content.js';
import { OpenAICompatProvider } from './openai-compat.js';

// Observed on two broken upstream routes despite HTTP 200. Keep the match
// anchored and narrow: ordinary answers discussing proxy errors are valid.
const PROXY_ERROR_PREFIX = '### **Proxy error (HTTP ';

function proxyError(): Error & { status: number } {
  // Do not echo the upstream body: it may contain provider credential details.
  return Object.assign(new Error('ElectronHub upstream proxy error returned inside a completion'), { status: 502 });
}

export class ElectronHubProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'electronhub',
      name: 'ElectronHub',
      baseUrl: 'https://api.electronhub.ai/v1',
      // /models is public and would accept an invalid key. This read-only
      // endpoint authenticates without spending an inference request.
      validateUrl: 'https://api.electronhub.ai/v1/user/me',
      timeoutMs: 90_000,
    });
  }

  override async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    if (response.choices.some(choice => contentToString(choice.message.content).trimStart().startsWith(PROXY_ERROR_PREFIX))) {
      throw proxyError();
    }
    return response;
  }

  override async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const pending: ChatCompletionChunk[] = [];
    let prefix = '';
    let checked = false;
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      if (checked) {
        yield chunk;
        continue;
      }
      pending.push(chunk);
      const choice = chunk.choices.find(item => item.index === 0);
      prefix += contentToString(choice?.delta.content);
      const text = prefix.trimStart();
      if (text.startsWith(PROXY_ERROR_PREFIX)) throw proxyError();
      // Buffer only a possible error-heading prefix, including split SSE
      // chunks. Tool calls and ordinary text pass through immediately.
      if ((!text || PROXY_ERROR_PREFIX.startsWith(text)) &&
          !choice?.delta.tool_calls?.length && prefix.length < 256 && pending.length < 64) continue;
      checked = true;
      yield* pending;
      pending.length = 0;
    }
    yield* pending;
  }
}
