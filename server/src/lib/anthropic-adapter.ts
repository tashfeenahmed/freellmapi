import type { ChatMessage, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import type {
  AnthropicMessageParam,
  AnthropicMessage,
  AnthropicTool,
  AnthropicToolChoice,
  MessagesOptions,
  ContentBlock,
  ContentBlockParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  ImageBlockParam,
} from '@freellmapi/shared/anthropic-types.js';

// ---- Request: Anthropic → OpenAI ----

export interface AdaptedRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };
}

export function anthropicToOpenAI(options: MessagesOptions): AdaptedRequest {
  const openaiMessages: ChatMessage[] = [];

  // System prompt → system message at head
  if (options.system) {
    if (typeof options.system === 'string') {
      openaiMessages.push({ role: 'system', content: options.system });
    } else {
      // TextBlockParam[]
      const text = options.system
        .filter((b): b is TextBlockParam => b.type === 'text')
        .map(b => b.text)
        .join('\n\n');
      if (text) openaiMessages.push({ role: 'system', content: text });
    }
  }

  for (const m of options.messages) {
    const content = m.content;

    if (typeof content === 'string') {
      // Simple string content
      if (m.role === 'user') {
        openaiMessages.push({ role: 'user', content });
      } else {
        openaiMessages.push({ role: 'assistant', content });
      }
      continue;
    }

    // Content block array
    if (m.role === 'user') {
      // Check for tool_result blocks → tool messages
      const toolResults = content.filter((b): b is ToolResultBlockParam => b.type === 'tool_result');
      const nonToolBlocks = content.filter(b => b.type !== 'tool_result');

      if (nonToolBlocks.length > 0) {
        // Build user message from non-tool blocks
        const userContent = blocksToOpenAIContent(nonToolBlocks);
        openaiMessages.push({ role: 'user', content: userContent });
      }

      // Tool results as separate tool messages
      for (const tr of toolResults) {
        openaiMessages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : (tr.content?.map(b => (b as TextBlockParam).text ?? '').join('') ?? ''),
        });
      }
    } else {
      // Assistant: text → content, tool_use → tool_calls
      const textBlocks = content.filter((b): b is TextBlockParam => b.type === 'text');
      const toolBlocks = content.filter((b): b is ToolUseBlockParam => b.type === 'tool_use');

      const textContent = textBlocks.map(b => b.text).join('');

      let chatContent: string | null = textContent.length > 0 ? textContent : null;

      const toolCalls = toolBlocks.length > 0
        ? toolBlocks.map(tb => ({
            id: tb.id,
            type: 'function' as const,
            function: {
              name: tb.name,
              arguments: JSON.stringify(tb.input),
            },
          }))
        : undefined;

      if (toolCalls && toolCalls.length > 0 && !chatContent) {
        chatContent = null;
      }

      openaiMessages.push({
        role: 'assistant',
        content: chatContent,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  // Tool definitions
  const tools = options.tools?.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  // Tool choice mapping
  let toolChoice: AdaptedRequest['tool_choice'];
  if (options.tool_choice) {
    if (options.tool_choice.type === 'auto') toolChoice = 'auto';
    else if (options.tool_choice.type === 'any') toolChoice = 'required';
    else if (options.tool_choice.type === 'tool') toolChoice = { type: 'function', function: { name: options.tool_choice.name } };
    else if (options.tool_choice.type === 'none') toolChoice = 'none';
  }

  return {
    messages: openaiMessages,
    model: options.model,
    temperature: options.temperature,
    max_tokens: options.max_tokens,
    top_p: options.top_p,
    tools,
    tool_choice: toolChoice,
  };
}

function blocksToOpenAIContent(blocks: ContentBlockParam[]): ChatMessage['content'] {
  const texts: string[] = [];
  const images: Record<string, unknown>[] = [];

  for (const b of blocks) {
    if (b.type === 'text') {
      texts.push(b.text);
    } else if (b.type === 'image') {
      const img = b as ImageBlockParam;
      images.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.source.media_type};base64,${img.source.data}`,
        },
      });
    }
  }

  if (images.length === 0) return texts.join('');
  return [...texts.map(t => ({ type: 'text', text: t })), ...images];
}

// ---- Response: OpenAI → Anthropic ----

export function openAIToAnthropicResponse(
  result: ChatCompletionResponse,
  model: string,
): AnthropicMessage {
  const choice = result.choices?.[0];
  const message = choice?.message;

  const content: ContentBlock[] = [];

  // Text content
  const text = typeof message?.content === 'string'
    ? message.content
    : (Array.isArray(message?.content) ? message.content.map(b => (typeof b === 'string' ? b : ((b as any)?.text ?? ''))).join('') : '');

  if (text) {
    content.push({ type: 'text', text });
  }

  // Tool calls → tool_use blocks
  for (const tc of message?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input,
    });
  }

  // Ensure content is never empty
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // finish_reason → stop_reason
  const finishReason = choice?.finish_reason ?? null;
  let stopReason: AnthropicMessage['stop_reason'] = null;
  if (finishReason === 'stop') stopReason = 'end_turn';
  else if (finishReason === 'tool_calls') stopReason = 'tool_use';
  else if (finishReason === 'length') stopReason = 'max_tokens';
  else if (finishReason) stopReason = 'end_turn'; // fallback for unknown

  return {
    id: result.id,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.prompt_tokens ?? 0,
      output_tokens: result.usage?.completion_tokens,
    },
  };
}

// ---- Content extraction helpers ----

/** Extract pure text from Anthropic content for token estimation and vision/tools detection. */
export function anthropicContentToString(content: string | ContentBlockParam[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlockParam => b.type === 'text')
    .map(b => b.text)
    .join(' ');
}

/** Check if Anthropic messages contain any image block. */
export function anthropicHasImage(messages: AnthropicMessageParam[]): boolean {
  return messages.some(m =>
    Array.isArray(m.content) && m.content.some(b => b.type === 'image'),
  );
}

/** Rough token estimate from Anthropic messages (~4 chars/token). */
export function estimateAnthropicTokens(messages: AnthropicMessageParam[]): number {
  return messages.reduce((sum, m) => {
    const text = anthropicContentToString(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);
}
