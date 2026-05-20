/**
 * Anthropic Messages API Provider
 *
 * Anthropic uses a different API format than OpenAI:
 * - Endpoint: POST /v1/messages
 * - Requires anthropic-version header
 * - Uses max_tokens instead of max_tokens (in some versions)
 *
 * This provider handles the translation between OpenAI-compatible internal format
 * and Anthropic's native API format.
 */

import type { Platform } from '@freellmapi/shared/types.js';
import { BaseProvider } from './base.js';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;
  };
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  metadata?: Record<string, string>;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicProvider extends BaseProvider {
  readonly platform: Platform = 'anthropic';
  readonly name = 'Anthropic';
  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly version = '2023-06-01';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
    },
  ): Promise<ChatCompletionResponse> {
    const anthropicReq = this.buildRequest(messages, modelId, options);
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': this.version,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(anthropicReq),
      },
      60000, // Anthropic can take longer for complex responses
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    return this.normalizeResponse(data, modelId);
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
    },
  ): AsyncGenerator<ChatCompletionChunk> {
    const anthropicReq = this.buildRequest(messages, modelId, { ...options, stream: true });
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': this.version,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(anthropicReq),
      },
      60000,
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let eventId = '';
    let eventModel = modelId;
    let chunkIndex = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventId = line.slice(7);
          } else if (line.startsWith('data: ') && eventId === 'content_block_delta') {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'content_block_delta' && data.delta.type === 'text_delta') {
              yield {
                id: `anthropic-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: eventModel,
                choices: [{
                  index: 0,
                  delta: { content: data.delta.text },
                  finish_reason: null,
                }],
              };
              chunkIndex++;
            }
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'message_delta' && data.usage) {
              yield {
                id: `anthropic-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: eventModel,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: data.stop_reason,
                }],
              };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': this.version,
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20250501',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
        10000,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private buildRequest(
    messages: ChatMessage[],
    modelId: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      stream?: boolean;
    },
  ): AnthropicRequest {
    // Extract system message
    let systemMessage = '';
    const chatMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessage = msg.content as string;
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        chatMessages.push({
          role: msg.role,
          content: msg.content as string,
        });
      }
    }

    return {
      model: modelId,
      messages: chatMessages,
      system: systemMessage || undefined,
      max_tokens: options?.max_tokens ?? 4096,
      temperature: options?.temperature,
      top_p: options?.top_p,
      stream: options?.stream,
    };
  }

  private normalizeResponse(data: AnthropicResponse, modelId: string): ChatCompletionResponse {
    const text = data.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');

    return {
      id: data.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: data.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: data.stop_reason,
      }],
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: data.usage.input_tokens + data.usage.output_tokens,
      },
    };
  }
}
