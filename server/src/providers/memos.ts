/**
 * MemOS provider — bridges to the MemOS hosted inference API.
 *
 * MemOS uses a non-standard request/response format (user_id, conversation_id,
 * query, model_name) and returns content in `data.response`. This provider
 * translates between OpenAI-compatible ChatMessage[] and the MemOS wire format.
 *
 * Upstream: https://memos.memtensor.cn/api/openmem/v1/chat
 * Auth: Token-based (Authorization: Token <key>)
 *
 * Models: qwen3-32b, deepseek-r1, qwen2.5-72b-instruct
 */
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

const MEMOS_URL = 'https://memos.memtensor.cn/api/openmem/v1/chat';
const MAX_QUERY_CHARS = 12000;
const MAX_CONVO_TURNS = 8;

export class MemosProvider extends BaseProvider {
  readonly platform = 'memos' as const;
  readonly name = 'MemOS';

  /**
   * Flatten ChatMessage content (string | array of blocks) to plain string.
   */
  private contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((block: any) => (typeof block === 'string' ? block : (block?.text ?? '')))
        .join('');
    }
    try { return JSON.stringify(content); } catch { return String(content); }
  }

  /**
   * Convert OpenAI ChatMessage[] to MemOS query + system prompt.
   * Keeps only recent turns and enforces a character cap to avoid MemOS 500s.
   */
  private extractQuery(messages: ChatMessage[]): { system: string | null; query: string } {
    let system: string | null = null;
    for (const msg of messages) {
      if (msg.role === 'system') {
        system = this.contentToText(msg.content);
      }
    }

    let query = this.contentToText(messages[messages.length - 1]?.content ?? '');

    if (messages.length > 2) {
      const nonSystem = messages.filter(m => m.role !== 'system');
      const recent = nonSystem.slice(-MAX_CONVO_TURNS);
      const parts = recent.map(msg => {
        const prefix = msg.role === 'user' ? 'User' : 'Assistant';
        return `${prefix}: ${this.contentToText(msg.content)}`;
      });
      query = parts.join('\n\n');
    }

    if (query.length > MAX_QUERY_CHARS) {
      query = '[Earlier context truncated]\n\n' + query.slice(-MAX_QUERY_CHARS);
    }

    return { system, query };
  }

  /**
   * Extract content from MemOS response, handling variant payload shapes.
   */
  private extractResponse(data: any): string {
    const content =
      data?.data?.response ||
      data?.data?.content ||
      data?.data?.answer ||
      data?.content ||
      data?.answer ||
      '';
    if (!content && data?.error) {
      throw new Error(`MemOS upstream error: ${data.error}`);
    }
    if (!content) {
      throw new Error('MemOS returned empty content');
    }
    return content;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { system, query } = this.extractQuery(messages);

    const body: Record<string, unknown> = {
      user_id: 'freellmapi_proxy',
      conversation_id: `proxy_${Date.now().toString(36)}`,
      query,
      model_name: modelId,
      stream: false,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 8192,
      add_message_on_answer: false,
    };
    if (system) body.system_prompt = system;

    const res = await this.fetchWithTimeout(MEMOS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 180000); // MemOS can be slow — 3 minute timeout

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const snippet = errBody.length > 500 ? errBody.slice(0, 500) + '...' : errBody;
      throw new Error(`MemOS API error ${res.status}: ${snippet}`);
    }

    const data = await res.json();
    const content = this.extractResponse(data);

    const response: ChatCompletionResponse = {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      _routed_via: { platform: 'memos', model: modelId },
    };
    return response;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    // MemOS SSE is unreliable — fetch non-streaming and simulate chunks
    const full = await this.chatCompletion(apiKey, messages, modelId, options);
    const content = full.choices[0]?.message?.content ?? '';
    const text = typeof content === 'string' ? content : '';

    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      const token = i === 0 ? words[i] : ' ' + words[i];
      yield {
        id: full.id,
        object: 'chat.completion.chunk',
        created: full.created,
        model: modelId,
        choices: [{
          index: 0,
          delta: { content: token },
          finish_reason: null,
        }],
      };
    }

    yield {
      id: full.id,
      object: 'chat.completion.chunk',
      created: full.created,
      model: modelId,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // MemOS uses Token auth, not Bearer — try a lightweight request
    try {
      const res = await this.fetchWithTimeout(MEMOS_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_id: 'key_validation',
          conversation_id: 'validate',
          query: 'hi',
          model_name: 'qwen3-32b',
          stream: false,
          max_tokens: 5,
          add_message_on_answer: false,
        }),
      }, 15000);
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  }
}
