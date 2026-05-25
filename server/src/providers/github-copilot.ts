import crypto from 'crypto';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from './base.js';
import { contentToString } from '../lib/content.js';

/**
 * GitHub Copilot provider — Path B (opencode-style) auth.
 *
 * Auth model: the `apiKey` parameter is the raw GitHub OAuth access token
 * (`gho_...`) returned by the device flow. It's used directly as
 * `Authorization: Bearer ...` against `api.githubcopilot.com` — no
 * token-exchange / refresh dance. See `lib/copilot-auth.ts` for the flow
 * and the integration plan in vault for the rationale.
 *
 * Route selection: per-model. gpt-5-mini and gpt-5.4-mini speak the
 * Chat Completions wire format; gpt-5.2-codex speaks the Responses API
 * (different body + response shape). `shouldUseResponses` decides.
 *
 * Headers: every request carries 10 fixed headers + a fresh UUIDv4
 * `X-Request-Id`. `X-Initiator` is inferred from the message history
 * (`agent` if any prior assistant/tool message exists, else `user`).
 *
 * Out of scope (handled in v3 per the plan):
 *   - Claude family (/v1/messages route)
 *   - /models auto-discovery
 *   - Vision request handling
 *   - Token refresh scheduler (Path B uses long-lived OAuth tokens)
 *   - Tool-call fidelity on the Responses route (basic pass-through only)
 */

const COPILOT_BASE_URL = 'https://api.githubcopilot.com';

// Header constants from ericc-ch/copilot-api `src/lib/api-config.ts`. Bump
// these in lockstep when GitHub tightens version checks (historically every
// 6 months or so — track opencode + ericc-ch upstream for the canonical bump).
const EDITOR_VERSION = 'vscode/1.107.0';
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.26.7';
const USER_AGENT = 'GitHubCopilotChat/0.26.7';

const RESPONSES_MODELS = new Set<string>([
  'gpt-5.2-codex',
  // The plan lists more (gpt-5.1, gpt-5.3-codex, etc.) — left out of this
  // initial set per commander scope. Add ids here as they're enabled.
]);

function shouldUseResponses(modelId: string): boolean {
  return RESPONSES_MODELS.has(modelId);
}

function inferInitiator(messages: ChatMessage[]): 'user' | 'agent' {
  for (const m of messages) {
    if (m.role === 'assistant' || m.role === 'tool') return 'agent';
  }
  return 'user';
}

function buildHeaders(token: string, messages: ChatMessage[]): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Version': EDITOR_VERSION,
    'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
    'User-Agent': USER_AGENT,
    'Openai-Intent': 'conversation-panel',
    'X-GitHub-Api-Version': '2025-04-01',
    'X-Request-Id': crypto.randomUUID(),
    'X-Initiator': inferInitiator(messages),
  };
}

export class GitHubCopilotProvider extends BaseProvider {
  readonly platform: Platform = 'github-copilot';
  readonly name = 'GitHub Copilot';
  private readonly timeoutMs = 60000;

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    if (shouldUseResponses(modelId)) {
      return this.responsesCompletion(apiKey, messages, modelId, options, false);
    }
    return this.chatCompletionRoute(apiKey, messages, modelId, options, false);
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    if (shouldUseResponses(modelId)) {
      yield* this.streamResponsesRoute(apiKey, messages, modelId, options);
      return;
    }
    yield* this.streamChatRoute(apiKey, messages, modelId, options);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // /models is the cheapest no-side-effect endpoint that still requires
    // the full magic-header set. A 401/403 here means the token won't
    // work for inference either.
    const res = await this.fetchWithTimeout(`${COPILOT_BASE_URL}/models`, {
      method: 'GET',
      headers: buildHeaders(apiKey, []),
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }

  // ────────────────────────────────────────────────────────────────────
  // /chat/completions route
  // ────────────────────────────────────────────────────────────────────

  private async chatCompletionRoute(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Promise<ChatCompletionResponse> {
    const body = this.buildChatBody(messages, modelId, options, stream);
    const res = await this.fetchWithTimeout(`${COPILOT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(apiKey, messages),
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`GitHub Copilot API error ${res.status}: ${err.slice(0, 500)}`);
    }
    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  private async *streamChatRoute(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body = this.buildChatBody(messages, modelId, options, true);
    const res = await this.fetchWithTimeout(`${COPILOT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(apiKey, messages),
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`GitHub Copilot API error ${res.status}: ${err.slice(0, 500)}`);
    }
    yield* parseChatSse(res);
  }

  private buildChatBody(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    // opencode confirmed that Copilot's GPT route rejects `max_tokens`; the
    // documented per-call cap is the model's own context window anyway,
    // and the public Models REST API's 4-8k clamp does NOT apply here. So
    // we strip it for gpt-* ids. (Anthropic / Gemini routes still want
    // max_tokens; those aren't in scope yet but the check would gate
    // there too once added.)
    const isGpt = modelId.toLowerCase().startsWith('gpt-');
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.tools) body.tools = options.tools;
    if (options?.tool_choice !== undefined) body.tool_choice = options.tool_choice;
    if (options?.parallel_tool_calls !== undefined) body.parallel_tool_calls = options.parallel_tool_calls;
    if (!isGpt && options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;
    return body;
  }

  // ────────────────────────────────────────────────────────────────────
  // /responses route (OpenAI Responses API — different body shape)
  // ────────────────────────────────────────────────────────────────────

  private async responsesCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    _stream: boolean,
  ): Promise<ChatCompletionResponse> {
    const body = this.buildResponsesBody(messages, modelId, options, false);
    const res = await this.fetchWithTimeout(`${COPILOT_BASE_URL}/responses`, {
      method: 'POST',
      headers: buildHeaders(apiKey, messages),
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`GitHub Copilot API error ${res.status}: ${err.slice(0, 500)}`);
    }
    const data = await res.json() as ResponsesApiResponse;
    return responsesToChatCompletion(data, modelId, this.platform);
  }

  private async *streamResponsesRoute(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body = this.buildResponsesBody(messages, modelId, options, true);
    const res = await this.fetchWithTimeout(`${COPILOT_BASE_URL}/responses`, {
      method: 'POST',
      headers: buildHeaders(apiKey, messages),
      body: JSON.stringify(body),
    }, this.timeoutMs);

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`GitHub Copilot API error ${res.status}: ${err.slice(0, 500)}`);
    }
    yield* parseResponsesSse(res, modelId);
  }

  private buildResponsesBody(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    // Responses API: `instructions` carries system content; `input` is the
    // user/assistant conversation. Block types are `input_text` (for
    // user/system/tool turns) and `output_text` (for prior assistant
    // turns). This is a minimal-fidelity bridge — tool-call fidelity is
    // not yet preserved on this route (planned for v3 per the integration
    // plan).
    const systemTexts: string[] = [];
    const input: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
    for (const m of messages) {
      if (m.role === 'system') {
        const t = contentToString(m.content);
        if (t) systemTexts.push(t);
        continue;
      }
      const role = m.role === 'tool' ? 'user' : m.role;
      const blockType = m.role === 'assistant' ? 'output_text' : 'input_text';
      const text = contentToString(m.content);
      if (!text && !(m.role === 'assistant' && m.tool_calls?.length)) continue;
      input.push({
        role,
        content: [{ type: blockType, text }],
      });
    }

    const body: Record<string, unknown> = {
      model: modelId,
      input,
      stream,
    };
    if (systemTexts.length > 0) body.instructions = systemTexts.join('\n\n');
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.max_tokens !== undefined) body.max_output_tokens = options.max_tokens;
    return body;
  }
}

// ────────────────────────────────────────────────────────────────────────
// SSE parsing for the Chat Completions route — same line shape as OpenAI
// (`data: <json>\n\n`, terminated by `data: [DONE]`).
// ────────────────────────────────────────────────────────────────────────

async function* parseChatSse(res: Response): AsyncGenerator<ChatCompletionChunk> {
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
      } catch {
        // skip malformed chunk
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Responses API — non-stream shape + SSE stream shape.
// The non-stream response looks like:
//   { id, object: 'response', output: [{ type: 'message',
//     content: [{ type: 'output_text', text: '...' }] }],
//     usage: { input_tokens, output_tokens, total_tokens } }
// The stream emits typed events with a leading `event:` line and a
// `data: <json>` line. We only care about `response.output_text.delta`
// (text increments) and `response.completed` (final usage).
// ────────────────────────────────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}
interface ResponsesContentBlock {
  type: string;
  text?: string;
}
interface ResponsesOutputItem {
  type: string;
  content?: ResponsesContentBlock[];
}
interface ResponsesApiResponse {
  id?: string;
  created_at?: number;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
}

function responsesToChatCompletion(
  data: ResponsesApiResponse,
  modelId: string,
  platform: Platform,
): ChatCompletionResponse {
  let text = '';
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
    }
  }
  return {
    id: data.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: data.created_at ?? Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: data.usage?.total_tokens
        ?? ((data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)),
    },
    _routed_via: { platform, model: modelId },
  };
}

async function* parseResponsesSse(res: Response, modelId: string): AsyncGenerator<ChatCompletionChunk> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const decoder = new TextDecoder();
  let buffer = '';
  const chunkId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const evt of events) {
      // Each event block has multiple `key: value` lines. We only need
      // the `data:` line — the `event:` type is also present in `data`'s
      // `type` field, so reading the JSON is sufficient.
      let dataLine = '';
      for (const line of evt.split('\n')) {
        if (line.startsWith('data: ')) {
          dataLine = line.slice(6);
          break;
        }
      }
      if (!dataLine || dataLine === '[DONE]') continue;
      let payload: any;
      try {
        payload = JSON.parse(dataLine);
      } catch {
        continue;
      }

      if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: payload.delta },
            finish_reason: null,
          }],
        };
      } else if (payload.type === 'response.completed') {
        yield {
          id: chunkId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
          }],
        };
      }
    }
  }
}
