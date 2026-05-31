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
      .map((b) => (typeof b === 'string' ? b : (b as ContentTextBlock)?.type === 'text' ? (b as ContentTextBlock).text : ''))
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
