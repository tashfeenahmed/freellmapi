import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';
import type {
  AnthropicStreamEvent,
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  StopReason,
} from '@freellmapi/shared/anthropic-types.js';

interface ToolCallAccumulator {
  id?: string;
  name: string;
  args: string;
}

interface PreambleBuffer {
  id?: string;
  model?: string;
  created?: number;
  other: unknown[];
}

/**
 * Translate an OpenAI-style SSE chunk stream into Anthropic Messages API
 * streaming events. Maintains a state machine that tracks content block
 * lifecycles and buffers tool call deltas for atomic emission.
 */
export async function* openAIChunksToAnthropicEvents(
  chunks: AsyncGenerator<ChatCompletionChunk>,
  model: string,
  estimatedInputTokens: number,
): AsyncGenerator<AnthropicStreamEvent> {
  let messageId: string | undefined;
  let modelFromChunks: string | undefined;
  let preamble = false;
  const preambleChunks: unknown[] = [];

  let textStarted = false;
  let textBlockIndex = 0;
  const textBlocksCompleted = new Set<number>();

  const toolCallAcc = new Map<number, ToolCallAccumulator>();
  let upstreamFinish: string | null = null;
  let usageChunk: unknown = null;
  let hasStartedMessage = false;

  for await (const chunk of chunks) {
    const c = chunk as unknown as Record<string, unknown>;

    // Capture metadata
    if (c.id) messageId = c.id as string;
    if (c.model) modelFromChunks = c.model as string;

    // Error frame in stream
    if (c.error && !c.choices) {
      if (!hasStartedMessage) {
        throw new Error(`in-band provider error: ${(c.error as any)?.message ?? JSON.stringify(c.error).slice(0, 200)}`);
      }
      // After message_start, emit error event
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      } as MessageDeltaEvent;
      yield { type: 'message_stop' } as MessageStopEvent;
      return;
    }

    const choice = (c.choices as any[])?.[0];
    if (!choice) {
      if (c.usage) usageChunk = c;
      continue;
    }

    if (choice.finish_reason) upstreamFinish = choice.finish_reason;

    // Buffer tool_call deltas
    const toolCalls = choice.delta?.tool_calls as any[] | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        const idx = tc.index ?? 0;
        if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { name: '', args: '' });
        const acc = toolCallAcc.get(idx)!;
        if (tc.id && !acc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }

    // Text content
    const text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';

    // Detect tool_calls starting → close text block if open
    if (toolCalls && toolCalls.length > 0 && textStarted && !textBlocksCompleted.has(textBlockIndex)) {
      yield {
        type: 'content_block_stop',
        index: textBlockIndex,
      } as ContentBlockStopEvent;
      textBlocksCompleted.add(textBlockIndex);
      textBlockIndex++;
      textStarted = false;
    }

    if (text.length > 0) {
      // Start message if not yet started
      if (!hasStartedMessage) {
        hasStartedMessage = true;
        const msgId = messageId || `msg_${Date.now()}`;
        const msgModel = modelFromChunks || model;

        yield {
          type: 'message_start',
          message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: msgModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: estimatedInputTokens },
          },
        } as MessageStartEvent;

        // Flush preamble
        preamble = false;
      }

      // Start text block if first text
      if (!textStarted) {
        textStarted = true;
        yield {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        } as ContentBlockStartEvent;
      }

      yield {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: { type: 'text_delta', text },
      } as ContentBlockDeltaEvent;
    } else if (!hasStartedMessage) {
      // Preamble chunks (role delta, keep-alive) — buffer
      preamble = true;
      if (choice.delta) {
        preambleChunks.push(c);
      }
      continue;
    }
  }

  // Stream ended — finalize

  // Close text block if still open
  if (textStarted && !textBlocksCompleted.has(textBlockIndex)) {
    yield {
      type: 'content_block_stop',
      index: textBlockIndex,
    } as ContentBlockStopEvent;
    textBlocksCompleted.add(textBlockIndex);
    textBlockIndex++;
    textStarted = false;
  }

  // Emit tool_use blocks
  const sortedToolCalls = [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0]);
  for (const [origIdx, acc] of sortedToolCalls) {
    const blockIdx = textBlockIndex++;
    const toolId = acc.id && acc.id.length > 0 ? acc.id : `call_auto_${origIdx}`;

    // Parse JSON args
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(acc.args || '{}');
    } catch {
      // If partial JSON, try to salvage
      input = {};
    }

    yield {
      type: 'content_block_start',
      index: blockIdx,
      content_block: {
        type: 'tool_use',
        id: toolId,
        name: acc.name || 'unknown',
        input: {},
      },
    } as ContentBlockStartEvent;

    // Emit deltas for the JSON arguments
    const json = acc.args || '{}';
    // Split into reasonable chunks for delta emission
    const chunkSize = 50;
    for (let i = 0; i < json.length; i += chunkSize) {
      yield {
        type: 'content_block_delta',
        index: blockIdx,
        delta: {
          type: 'input_json_delta',
          partial_json: json.slice(i, i + chunkSize),
        },
      } as ContentBlockDeltaEvent;
    }

    yield {
      type: 'content_block_stop',
      index: blockIdx,
    } as ContentBlockStopEvent;
  }

  // Emit tool_use input as actual parsed objects (overwrite the chunked deltas)
  // Actually the deltas should add up, let's emit the final message_delta

  // Determine stop_reason
  let stopReason: StopReason;
  if (sortedToolCalls.length > 0) {
    stopReason = 'tool_use';
  } else if (upstreamFinish === 'length') {
    stopReason = 'max_tokens';
  } else {
    stopReason = 'end_turn';
  }

  // Check for empty completion
  const hasContent = textBlocksCompleted.size > 0 || sortedToolCalls.length > 0;
  if (!hasContent) {
    throw new Error('empty completion (stream produced no content and no tool calls)');
  }

  // Start message if never started (empty stream with just tool calls)
  if (!hasStartedMessage) {
    hasStartedMessage = true;
    const msgId = messageId || `msg_${Date.now()}`;
    const msgModel = modelFromChunks || model;
    yield {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: msgModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: estimatedInputTokens },
      },
    } as MessageStartEvent;
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  } as MessageDeltaEvent;

  yield { type: 'message_stop' } as MessageStopEvent;
}
