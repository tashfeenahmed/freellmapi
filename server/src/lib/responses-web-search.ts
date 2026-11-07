import crypto from 'crypto';
import type { Request, Response } from 'express';
import {
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_FUNCTION_DESCRIPTION,
  WEB_SEARCH_FUNCTION_PARAMETERS,
  hasSearchCapability,
  performWebSearch,
  formatOutcomeForModel,
  newWebSearchCallId,
  invokeHandlerCaptured,
  copyCapturedHeaders,
  resolveMaxSearches,
  type WebSearchOutcome,
  type DomainFilter,
} from './web-search-tool.js';

// OpenAI Responses `web_search` tool (Codex) served from the gateway's search
// pool (#1174). Before this the tool was dropped at conversion and the model
// could not search at all. The routed model sees a plain `web_search`
// function; each call runs here and is reported to the client as a
// `web_search_call` output item (action.type 'search', with its sources),
// exactly where OpenAI would put it, ahead of the final answer.

const HEARTBEAT_MS = 5_000;
// Commit the stream (response.created) if the first model turn has not come
// back by then, so Codex's stream idle watchdog sees events. A faster first
// turn that fails keeps its real HTTP status instead.
const STREAM_COMMIT_AFTER_MS = 3_000;

/** `web_search`, `web_search_preview`, and their dated variants. */
export function isResponsesWebSearchTool(tool: unknown): boolean {
  const type = (tool as { type?: unknown } | null)?.type;
  return typeof type === 'string' && /^web_search(_preview)?(_\d{4}_\d{2}_\d{2})?$/.test(type);
}

type Item = Record<string, any>;

/** A replayed web_search_call item → a note the routed model can read. */
export function webSearchCallToText(item: Item): string {
  const action = item?.action;
  const query = typeof action?.query === 'string' ? action.query : '';
  if (!query) return '';
  const sources = Array.isArray(action?.sources)
    ? action.sources.map((s: Item) => s?.url).filter((u: unknown): u is string => typeof u === 'string')
    : [];
  return sources.length > 0
    ? `[Searched the web for: ${query}. Sources: ${sources.slice(0, 10).join(', ')}]`
    : `[Searched the web for: ${query}]`;
}

function isOurSearchCall(item: Item): boolean {
  return item?.type === 'function_call' && item?.name === WEB_SEARCH_TOOL_NAME;
}

function searchCallItem(id: string, query: string, outcome: WebSearchOutcome | null): Item {
  const sources = outcome?.ok ? outcome.results.map(hit => ({ type: 'url', url: hit.url })) : undefined;
  return {
    type: 'web_search_call',
    id,
    status: outcome ? (outcome.ok ? 'completed' : 'failed') : 'in_progress',
    action: { type: 'search', query, ...(sources ? { sources } : {}) },
  };
}

function itemText(item: Item): string {
  if (item?.type !== 'message' || !Array.isArray(item.content)) return '';
  return item.content.map((p: Item) => (p?.type === 'output_text' && typeof p.text === 'string' ? p.text : '')).join('');
}

class ResponsesSse {
  private seq = 0;
  private outputIndex = 0;
  private started = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private skeleton: Item;
  constructor(private res: Response, responseId: string, model: string) {
    this.skeleton = { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [], output_text: '' };
  }

  get committed(): boolean { return this.started; }

  private write(event: string, payload: Record<string, unknown>): void {
    if (this.res.writableEnded || this.res.destroyed) return;
    try {
      this.res.write(`event: ${event}\n`);
      this.res.write(`data: ${JSON.stringify({ type: event, sequence_number: this.seq++, ...payload })}\n\n`);
    } catch { /* socket teardown race */ }
  }

  start(): void {
    if (this.started) return;
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.write('response.created', { response: this.skeleton });
    this.write('response.in_progress', { response: this.skeleton });
    this.started = true;
    // Same keep-alive Fusion uses: Codex's client watchdog ignores SSE
    // comments but resets on any standard event.
    this.heartbeat = setInterval(() => this.write('response.in_progress', { response: this.skeleton }), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  searchStarted(item: Item): number {
    const idx = this.outputIndex++;
    this.write('response.output_item.added', { output_index: idx, item });
    this.write('response.web_search_call.in_progress', { output_index: idx, item_id: item.id });
    this.write('response.web_search_call.searching', { output_index: idx, item_id: item.id });
    return idx;
  }

  searchDone(idx: number, item: Item): void {
    this.write('response.web_search_call.completed', { output_index: idx, item_id: item.id });
    this.write('response.output_item.done', { output_index: idx, item });
  }

  item(item: Item): void {
    const idx = this.outputIndex++;
    if (item.type === 'message') {
      const text = itemText(item);
      this.write('response.output_item.added', { output_index: idx, item: { ...item, status: 'in_progress', content: [] } });
      this.write('response.content_part.added', { item_id: item.id, output_index: idx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      if (text) this.write('response.output_text.delta', { item_id: item.id, output_index: idx, content_index: 0, delta: text });
      this.write('response.output_text.done', { item_id: item.id, output_index: idx, content_index: 0, text });
      this.write('response.content_part.done', { item_id: item.id, output_index: idx, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
    } else if (item.type === 'function_call') {
      this.write('response.output_item.added', { output_index: idx, item: { ...item, status: 'in_progress', arguments: '' } });
      if (item.arguments) this.write('response.function_call_arguments.delta', { item_id: item.id, output_index: idx, delta: item.arguments });
      this.write('response.function_call_arguments.done', { item_id: item.id, output_index: idx, arguments: item.arguments ?? '' });
    } else {
      this.write('response.output_item.added', { output_index: idx, item });
    }
    this.write('response.output_item.done', { output_index: idx, item });
  }

  complete(response: Item): void {
    this.stopHeartbeat();
    this.write(response.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
    try { this.res.end(); } catch { /* already closed */ }
  }

  fail(error: Item): void {
    this.stopHeartbeat();
    this.write('response.failed', { response: { ...this.skeleton, status: 'failed', error } });
    try { this.res.end(); } catch { /* already closed */ }
  }

  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

/**
 * Serve a /v1/responses request that carries a `web_search` tool from the
 * search pool. Returns false (nothing sent) when the request has no such
 * tool, is a Fusion request, or no search key exists — the caller then runs
 * the normal handler, which drops the tool exactly as before.
 */
export async function maybeServeResponsesWebSearch(
  handler: (req: Request, res: Response) => Promise<void>,
  req: Request,
  res: Response,
): Promise<boolean> {
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) return false;
  if (body.fusion != null || body.model === 'fusion') return false;
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) return false;
  const searchTool = body.tools.find(isResponsesWebSearchTool);
  if (!searchTool || !hasSearchCapability()) return false;

  const filter: DomainFilter = {
    allowedDomains: Array.isArray(searchTool.filters?.allowed_domains) ? searchTool.filters.allowed_domains.filter((d: unknown) => typeof d === 'string') : undefined,
    blockedDomains: Array.isArray(searchTool.filters?.blocked_domains) ? searchTool.filters.blocked_domains.filter((d: unknown) => typeof d === 'string') : undefined,
  };
  const maxSearches = resolveMaxSearches(body.max_tool_calls);
  let replaced = false;
  const tools = body.tools.flatMap((t: Item) => {
    if (!isResponsesWebSearchTool(t)) return [t];
    if (replaced) return [];
    replaced = true;
    return [{ type: 'function', name: WEB_SEARCH_TOOL_NAME, description: WEB_SEARCH_FUNCTION_DESCRIPTION, parameters: WEB_SEARCH_FUNCTION_PARAMETERS, strict: false }];
  });

  const responseId = `resp_${crypto.randomBytes(16).toString('hex')}`;
  const wantsStream = body.stream === true;
  const sse = wantsStream ? new ResponsesSse(res, responseId, typeof body.model === 'string' ? body.model : 'auto') : null;
  const assembled: Item[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let searchesRun = 0;
  let input: Item[] = typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: body.input }]
    : [...body.input];
  const maxTurns = maxSearches + 2;
  let commitTimer: NodeJS.Timeout | null = null;

  const emitItem = (item: Item) => {
    assembled.push(item);
    sse?.item(item);
  };

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const lastTurn = turn === maxTurns - 1;
      let toolChoice = body.tool_choice;
      if (turn > 0 && toolChoice === 'required') toolChoice = 'auto';
      const innerBody = {
        ...body,
        stream: false,
        input,
        tools,
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      };
      if (sse && !sse.committed && turn === 0) {
        commitTimer = setTimeout(() => sse.start(), STREAM_COMMIT_AFTER_MS);
        commitTimer.unref?.();
      }
      const captured = await invokeHandlerCaptured(handler, req, res, innerBody);
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      if (res.writableEnded || res.destroyed) return true;

      if (captured.status !== 200 || captured.body?.object !== 'response') {
        if (sse?.committed) {
          const error = captured.body?.error ?? { message: `upstream error (HTTP ${captured.status})`, type: 'server_error' };
          sse.fail(error);
        } else {
          copyCapturedHeaders(captured, res);
          res.status(captured.status).json(captured.body);
        }
        return true;
      }

      const reply = captured.body;
      usage.input_tokens += Number(reply.usage?.input_tokens) || 0;
      usage.output_tokens += Number(reply.usage?.output_tokens) || 0;
      copyCapturedHeaders(captured, res);
      sse?.start();

      const output: Item[] = Array.isArray(reply.output) ? reply.output : [];
      const searchCalls = output.filter(isOurSearchCall);
      const clientCalls = output.filter(item => item?.type === 'function_call' && !isOurSearchCall(item));

      if (searchCalls.length === 0 || clientCalls.length > 0 || lastTurn) {
        for (const item of output) if (!isOurSearchCall(item)) emitItem(item);
        const finalResponse = {
          ...reply,
          id: responseId,
          // Keep a token-limit or content-filter cut visible (see routes/responses.ts).
          status: reply.status === 'incomplete' ? 'incomplete' : 'completed',
          output: assembled,
          output_text: assembled.map(itemText).join(''),
          usage: {
            ...(reply.usage ?? {}),
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
          },
        };
        if (sse) sse.complete(finalResponse);
        else res.status(200).json(finalResponse);
        return true;
      }

      const followUp: Item[] = [];
      for (const item of output) {
        if (!isOurSearchCall(item)) {
          emitItem(item);
          // Interim assistant text goes back into the next turn's history;
          // reasoning items have no chat equivalent and are dropped anyway.
          if (item.type === 'message') followUp.push(item);
          continue;
        }
        let args: Item = {};
        try { args = JSON.parse(item.arguments ?? '{}'); } catch { /* malformed → invalid input */ }
        const query = typeof args.query === 'string' ? args.query : '';
        const callId = newWebSearchCallId();
        const progressIdx = sse?.searchStarted(searchCallItem(callId, query, null));
        let outcome: WebSearchOutcome;
        if (searchesRun >= maxSearches) {
          outcome = { ok: false, query, errorCode: 'max_uses_exceeded', message: 'max searches exceeded' };
        } else {
          searchesRun++;
          outcome = await performWebSearch(args.query, filter);
        }
        const done = searchCallItem(callId, query, outcome);
        assembled.push(done);
        if (sse && progressIdx !== undefined) sse.searchDone(progressIdx, done);
        followUp.push(
          { type: 'function_call', call_id: item.call_id, name: WEB_SEARCH_TOOL_NAME, arguments: item.arguments ?? '{}' },
          { type: 'function_call_output', call_id: item.call_id, output: formatOutcomeForModel(outcome) },
        );
      }
      input = [...input, ...followUp];
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (sse?.committed) sse.fail({ message: `web search failed: ${message}`, type: 'server_error' });
    else if (!res.headersSent) res.status(500).json({ error: { message: `web search failed: ${message}`, type: 'server_error' } });
    return true;
  } finally {
    if (commitTimer) clearTimeout(commitTimer);
    sse?.stopHeartbeat();
  }
  return true;
}
