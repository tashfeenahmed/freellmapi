import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

export class OpenModelProvider extends BaseProvider {
  readonly platform = 'openmodel' as const;
  readonly name = 'OpenModel';

  private contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block: any) => (typeof block === 'string' ? block : (block?.text ?? '')))
        .join('');
    }
    return String(content ?? '');
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    let systemPrompt: string | undefined = undefined;
    const filteredMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = this.contentToText(msg.content);
      } else {
        filteredMessages.push({
          role: msg.role,
          content: this.contentToText(msg.content),
        });
      }
    }

    const body: Record<string, any> = {
      model: modelId,
      messages: filteredMessages,
      max_tokens: options?.max_tokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      stream: false,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const res = await this.fetchWithTimeout('https://api.openmodel.ai/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 60000);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenModel API error ${res.status}: ${errText}`);
    }

    const data = await res.json() as any;

    let content = '';
    let reasoningContent: string | undefined = undefined;

    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          content += block.text;
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          reasoningContent = block.thinking;
        }
      }
    }

    const response: ChatCompletionResponse = {
      id: data.id ?? this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: content || reasoningContent || '',
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens ?? 0,
        completion_tokens: data.usage?.output_tokens ?? 0,
        total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      _routed_via: { platform: 'openmodel', model: modelId },
    };
    return response;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    let systemPrompt: string | undefined = undefined;
    const filteredMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = this.contentToText(msg.content);
      } else {
        filteredMessages.push({
          role: msg.role,
          content: this.contentToText(msg.content),
        });
      }
    }

    const body: Record<string, any> = {
      model: modelId,
      messages: filteredMessages,
      max_tokens: options?.max_tokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      stream: true,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const res = await this.fetchWithTimeout('https://api.openmodel.ai/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 60000);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenModel API error ${res.status}: ${errText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let messageId = this.makeId();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') return;
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.type === 'message_start' && parsed.message?.id) {
            messageId = parsed.message.id;
          }
          if (parsed.type === 'content_block_delta') {
            if (parsed.delta?.text) {
              yield {
                id: messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                  index: 0,
                  delta: { content: parsed.delta.text },
                  finish_reason: null,
                }],
              };
            } else if (parsed.delta?.thinking) {
              yield {
                id: messageId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                  index: 0,
                  delta: { reasoning_content: parsed.delta.thinking } as any,
                  finish_reason: null,
                }],
              };
            }
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    yield {
      id: messageId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
  }

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('https://api.openmodel.ai/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
      }, 15000);
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }
}
