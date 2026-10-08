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

// Rough input-token count (~4 chars per token) used for routing and budget
// checks: message text, assistant tool-call arguments, and the tool schemas
// the request carries. Tool schemas go upstream on every turn and count
// against the provider's context window and TPM ceiling. An agent client like
// Claude Code sends ~16k tokens of them next to ~4k of messages, so leaving
// them out routed its requests to models they could never fit (a Groq 8k-TPM
// model answered 413 to an "estimated" 4k request that was really 17.7k).
export function estimateInputTokens(messages: ChatMessage[], tools?: readonly unknown[]): number {
  const messageTokens = messages.reduce((sum, m) => {
    const calls = (m.tool_calls ?? [])
      .reduce((n, call) => n + call.function.name.length + call.function.arguments.length, 0);
    return sum + Math.ceil((contentToString(m.content).length + calls) / 4);
  }, 0);
  const toolTokens = tools && tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / 4) : 0;
  return messageTokens + toolTokens;
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

// Drop image blocks from every message so a text-only model (e.g. the fusion
// judge, which synthesizes from panel text answers) never receives pixels.
export function stripImagesFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const kept = m.content.filter((block) => {
      const type = (block as { type?: string })?.type;
      return type !== 'image_url' && type !== 'image';
    });
    if (kept.length === m.content.length) return m;
    return { ...m, content: kept.length > 0 ? kept : '' };
  });
}

// GitHub Models refuses a long history outright (413) rather than truncating
// it the way most providers do, so an oversized body turns every github hop in
// the fallback chain into a wasted attempt. 7500 is the input budget we trim
// to: comfortably inside the ~8000-token ceiling observed live, with room for
// the tool schemas and the system prompt the gateway prepends.
export const GITHUB_MAX_INPUT_TOKENS = 7500;

// The proxy's own chars/4 input estimate, per message — same arithmetic the
// routing/budget paths use, so the guard below trims against the number the
// rest of the gateway reasons about.
function estimateMessageTokens(message: ChatMessage): number {
  return Math.ceil(contentToString(message.content).length / 4);
}

// Trim one message's text down to a token budget. Non-string content
// (multimodal envelopes) is returned untouched — dropping or rewriting image
// blocks here would corrupt the envelope, and text is the only thing this
// guard is allowed to shorten.
function truncateMessageText(message: ChatMessage, budget: number): ChatMessage {
  if (typeof message.content !== 'string') return message;
  const maxChars = Math.max(0, budget) * 4;
  return message.content.length <= maxChars
    ? message
    : { ...message, content: message.content.slice(0, maxChars) };
}

/**
 * Fit a message list inside GitHub Models' input ceiling before dispatch.
 * Keeps the leading system prompt verbatim (its instructions are the whole
 * point of prepending one) and then as many of the NEWEST messages as the
 * remaining budget allows, dropping the oldest turns first — the same trade a
 * client's own context window makes. A single message that blows the budget on
 * its own is truncated rather than dropped, so the turn is never dispatched
 * with nothing to answer.
 *
 * Returns the ORIGINAL array when the request already fits, which is both the
 * common case and the cheap one: callers can hand every github-routed request
 * through here without copying anything.
 */
export function truncateMessagesForGithub(
  messages: ChatMessage[],
  budget: number = GITHUB_MAX_INPUT_TOKENS,
): ChatMessage[] {
  if (messages.length === 0) return messages;
  const total = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  if (total <= budget) return messages;

  const systemIdx = messages.findIndex(m => m.role === 'system');
  const systemMessage = systemIdx >= 0 ? messages[systemIdx] : null;
  const rest = messages.filter((_, i) => i !== systemIdx);

  const systemTokens = systemMessage ? estimateMessageTokens(systemMessage) : 0;
  let used = systemTokens;
  const kept: ChatMessage[] = [];
  // Newest → oldest: the most recent context is the context the answer needs.
  for (let i = rest.length - 1; i >= 0; i--) {
    const tokens = estimateMessageTokens(rest[i]);
    if (used + tokens > budget) break;
    kept.unshift(rest[i]);
    used += tokens;
  }
  // Nothing fit alongside the system prompt: keep the newest message in
  // truncated form instead of sending an empty conversation.
  if (kept.length === 0 && rest.length > 0) {
    kept.push(truncateMessageText(rest[rest.length - 1], budget - systemTokens));
  }
  return systemMessage ? [systemMessage, ...kept] : kept;
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
