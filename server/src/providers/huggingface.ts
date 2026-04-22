import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';

const API_BASE = 'https://router.huggingface.co/fireworks-ai/inference/v1';

export class HuggingFaceProvider extends BaseProvider {
  readonly platform = 'huggingface' as const;
  readonly name = 'Hugging Face';

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    // HF Inference API supports OpenAI-compatible chat endpoint
    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`HuggingFace API error ${res.status}: ${(err as any).error ?? res.statusText}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: 'huggingface', model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`HuggingFace API error ${res.status}: ${(err as any).error ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as ChatCompletionChunk;
        } catch { /* skip */ }
      }
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout('https://huggingface.co/api/whoami-v2', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      }, 10000);
      return res.ok;
    } catch {
      return false;
    }
  }
}
