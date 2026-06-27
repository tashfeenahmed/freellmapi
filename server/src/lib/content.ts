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

// Harden the OUTBOUND envelope so strict OpenAI clients don't choke on the
// shape variations free-tier providers emit. Complements normalizeOutboundContent
// (which fixes array content) by fixing the *frame* fields, not the content:
//   - `model` coerced to a string (some providers send null/number).
//   - `choices[].finish_reason` defaulted to null when absent — the field must
//     exist per spec; Rust agents (the #200 class of compat bugs) branch on it.
//   - a literal `tool_calls: null` on a message/delta is DELETED — OpenAI omits
//     the field entirely when there are no calls, and `null` breaks clients that
//     test for its presence (this is the response-side mirror of the #200 fix).
// Content, real tool_calls arrays, reasoning_content, and every other field are
// left untouched. Mutates and returns the same object (frames are parsed fresh
// per SSE line, so in-place mutation is safe), matching normalizeOutboundContent.
export function sanitizeResponse<T>(payload: T): T {
  const p = payload as { model?: unknown; choices?: unknown };
  if (!p || typeof p !== 'object') return payload;
  if (p.model != null && typeof p.model !== 'string') p.model = String(p.model);
  if (Array.isArray(p.choices)) {
    for (const choice of p.choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as { finish_reason?: unknown; message?: { tool_calls?: unknown }; delta?: { tool_calls?: unknown } };
      if (c.finish_reason === undefined) c.finish_reason = null;
      if (c.message && typeof c.message === 'object' && c.message.tool_calls === null) delete c.message.tool_calls;
      if (c.delta && typeof c.delta === 'object' && c.delta.tool_calls === null) delete c.delta.tool_calls;
    }
  }
  return payload;
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
