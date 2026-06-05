import type { ChatMessage } from '@freellmapi/shared/types.js';

// OpenAI-spec message content can be one of:
//   - string                        (plain text)
//   - null                          (assistant with tool_calls only)
//   - Array<ContentBlock>           (multimodal envelope; we extract text only)
//
// freellmapi accepts the array envelope so clients like opencode and
// continue.dev (which always serialize as arrays) don't 400. Non-text blocks
// are dropped silently — vision/audio aren't supported (see README).
export type ContentTextBlock = { type: 'text'; text: string };
export type ContentBlock = ContentTextBlock | { type: string; [key: string]: unknown };

export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        const block = b as { type?: string; text?: unknown };
        // OpenAI blocks carry type:'text'; Gemini-lineage agents (Qwen Code,
        // AionUI) send part-style `{ text }` with no type at all — accept any
        // block whose `text` is a string and whose type doesn't say it's
        // something else. (#200)
        if (typeof block?.text === 'string' && (block.type === 'text' || block.type === undefined)) {
          return block.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function flattenMessageContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    content: contentToString(m.content),
  }));
}

// True if the content array carries an image block. OpenAI's multimodal
// envelope uses `{ type: 'image_url', image_url: { url } }`; some clients send
// a bare `{ type: 'image', ... }`.
export function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const type = (block as { type?: string })?.type;
    return type === 'image_url' || type === 'image';
  });
}

// True if any message carries an image content block. Used to route image
// requests only to vision-capable models (#118, #125).
export function messageHasImage(messages: ChatMessage[]): boolean {
  return messages.some((m) => contentHasImage(m.content));
}

// Normalize the OUTBOUND (provider → client) shape so we honor the OpenAI
// contract on the response path the same way `contentToString` does on the
// request path. Per spec, `choices[].delta.content` (streaming) and
// `choices[].message.content` (non-stream) are strings; some providers
// (e.g. Mistral magistral) return an array of content blocks. Forwarding the
// array verbatim breaks string-consuming clients ("expected str, got list")
// and, mid-stream, drops the turn's tool calls. We coerce array content to a
// string while leaving `tool_calls` and every other field untouched. Mutates
// and returns the same object (chunks are parsed fresh from JSON per frame, so
// in-place mutation is safe). Non-array content passes through unchanged. (#166)
export function normalizeOutboundContent<T>(payload: T): T {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices)) return payload;
  for (const choice of choices) {
    const delta = (choice as { delta?: { content?: unknown } })?.delta;
    if (delta && Array.isArray(delta.content)) {
      delta.content = contentToString(delta.content);
    }
    const message = (choice as { message?: { content?: unknown } })?.message;
    if (message && Array.isArray(message.content)) {
      message.content = contentToString(message.content);
    }
  }
  return payload;
}
