/**
 * Inline tool-call dialect rescue (#231 audit).
 *
 * When a conversation switches models mid-task (failover, sticky miss), the
 * new model often continues the previous model's tool-call style and emits
 * the call as TEXT in its private training dialect instead of a structured
 * `tool_calls` array. The client's agent loop sees prose, treats the turn as
 * a final answer, and dies mid-task — observed live with the OpenAI Agents
 * SDK when Kimi-K2.6 continued a DeepSeek history:
 *
 *   <|tool_calls_section_begin|> <|tool_call_begin|> chatcmpl-tool-bde5...
 *
 * This module detects the known dialects and re-parses them into standard
 * OpenAI tool_calls, schema-gated against the request's tool list. A turn
 * that is detected as a dialect but cannot be parsed into a known tool is a
 * DEAD turn — the caller fails over instead of delivering gibberish.
 *
 * Supported dialects:
 *  1. Kimi / DeepSeek token style:
 *     <|tool_calls_section_begin|><|tool_call_begin|>functions.NAME:0
 *     <|tool_call_argument_begin|>{...}<|tool_call_end|>...
 *  2. Llama / Groq function tags: <function=NAME{...}</function> and
 *     <function=NAME>{...}</function>
 *  3. Qwen / Hermes XML: <tool_call>{"name": ..., "arguments": ...}</tool_call>
 *  4. Bare or ```json-fenced single JSON object: {"name": KNOWN, "arguments": {...}}
 *     (only rescued when "name" matches a requested tool — bare JSON is a
 *     legitimate answer shape, so this one is strictly schema-gated)
 *  5. Dots XML: <dots_function_call><invoke name="NAME">
 *     <parameter name="k">v</parameter></invoke></dots_function_call>
 *     (parameter values: JSON numbers/booleans/arrays/objects get that type,
 *     everything else is a string)
 *  6. Claude-style XML, same body as dots under a <function_calls> wrapper:
 *     <function_calls><invoke name="NAME"><parameter name="k">v</parameter>
 *     </invoke></function_calls> (#2117: models answering Claude Code's
 *     prompt copy this shape as text)
 */

export interface RescuedToolCall {
  name: string;
  /** JSON string, exactly like OpenAI's function.arguments */
  arguments: string;
}

export interface RescueResult {
  /** True when the text contains inline tool-call dialect markers. */
  detected: boolean;
  /** Parsed calls; null when detected but unparseable (dead turn). */
  calls: RescuedToolCall[] | null;
  /** Text with the dialect blocks removed (may be ''). */
  cleanText: string;
}

// Markers that begin an inline dialect block. Used both for full-text
// detection and for the streaming hold-window decision in proxy.ts.
const DIALECT_MARKERS = [
  '<|tool_calls_section_begin|>',
  '<|tool_call_begin|>',
  '<tool_call>',
  '<function=',
  '<dots_function_call>',
  '<function_calls>',
] as const;

/** Does the (trimmed) text start with a known dialect marker? */
export function startsWithDialectMarker(text: string): boolean {
  const t = text.trimStart();
  return DIALECT_MARKERS.some(m => t.startsWith(m));
}

/**
 * Streaming hold-window helper: could `text` still grow into a dialect
 * marker? True while text is a strict prefix of some marker (e.g. "<|too"),
 * so the stream loop keeps holding; once this and startsWithDialectMarker
 * are both false the text is ordinary prose and can be flushed.
 */
export function couldBecomeDialectMarker(text: string): boolean {
  const t = text.trimStart();
  if (t.length === 0) return true;
  return DIALECT_MARKERS.some(m => m.startsWith(t) && t.length < m.length);
}

/** Anywhere-in-text detection for the non-streaming path. */
export function containsDialectMarker(text: string): boolean {
  return DIALECT_MARKERS.some(m => text.includes(m));
}

/**
 * Streaming hold-window helpers for dialect 4 (#2117): an answer that opens
 * with `{` or a ```json fence may be a whole tool call written as JSON, which
 * rescueInlineToolCalls only recognises once the full text is known. Callers
 * use these only for tool-carrying requests, since they hold the whole answer.
 */
const JSON_FENCE_HEAD = /^```(?:json)?\s*/;

export function startsWithJsonToolCallShape(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith('{')) return true;
  const fence = JSON_FENCE_HEAD.exec(t);
  return fence !== null && t[fence[0].length] === '{';
}

export function couldBecomeJsonToolCallShape(text: string): boolean {
  const t = text.trimStart();
  if (t.length === 0) return true;
  if ('```json'.startsWith(t)) return true;
  const fence = JSON_FENCE_HEAD.exec(t);
  return fence !== null && fence[0].length === t.length;
}

/**
 * Where the first dialect marker starts in `text`, or -1. Lets a stream that
 * already sent prose ("I'll create the file now.") still hold and rescue a
 * tool call that comes after it, instead of sending it to the client as text.
 */
export function indexOfDialectMarker(text: string): number {
  let first = -1;
  for (const m of DIALECT_MARKERS) {
    const at = text.indexOf(m);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  return first;
}

/**
 * Length of the longest tail of `text` that is the start of a dialect marker
 * (e.g. "<tool_" at the end of a chunk). A stream holds this tail back until
 * the next chunk shows whether a marker follows.
 */
export function partialDialectMarkerTail(text: string): number {
  const from = text.lastIndexOf('<');
  if (from === -1) return 0;
  const tail = text.slice(from);
  return DIALECT_MARKERS.some(m => m.length > tail.length && m.startsWith(tail)) ? tail.length : 0;
}

/**
 * Extract one balanced JSON object or array starting at text[from] (which
 * must be '{' or '['). Returns the slice and the index after it, or null.
 * String-aware so braces inside JSON strings don't break the balance.
 */
function extractBalancedJson(text: string, from: number): { json: string; end: number } | null {
  const open = text[from];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { json: text.slice(from, i + 1), end: i + 1 };
    }
  }
  return null;
}

// An empty set means the request declared no tools, so NOTHING is callable.
// This used to read `toolNames.size === 0 || …`, which inverted that: a turn
// with no tools opened the gate for every name the dialect parsers found.
const isKnownTool = (name: string, toolNames: Set<string>): boolean =>
  toolNames.has(name);

/** Parse `{"name": ..., "arguments"|"parameters": ...}` into a call. */
function callFromNamedJson(json: string, toolNames: Set<string>): RescuedToolCall | null {
  let obj: unknown;
  try { obj = JSON.parse(json); } catch { return null; }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : undefined;
  if (!name || !isKnownTool(name, toolNames)) return null;
  const rawArgs = o.arguments ?? o.parameters ?? {};
  const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
  try { JSON.parse(args); } catch { return null; }
  return { name, arguments: args };
}

/** Dialect 1: Kimi/DeepSeek <|tool_call_begin|> token blocks. */
function parseTokenDialect(text: string, toolNames: Set<string>): { calls: RescuedToolCall[] | null; cleanText: string } {
  const calls: RescuedToolCall[] = [];
  let clean = text;
  // Strip section wrappers first; they carry no information.
  clean = clean.replaceAll('<|tool_calls_section_begin|>', '').replaceAll('<|tool_calls_section_end|>', '');

  const callRe = /<\|tool_call_begin\|>\s*([\s\S]*?)\s*<\|tool_call_argument_begin\|>\s*/g;
  let m: RegExpExecArray | null;
  let parsedAll = true;
  const spans: Array<{ from: number; to: number }> = [];
  while ((m = callRe.exec(clean)) !== null) {
    const idToken = m[1].trim();
    const argStart = m.index + m[0].length;
    const jsonStart = clean.indexOf('{', argStart);
    const extracted = jsonStart === -1 ? null : extractBalancedJson(clean, jsonStart);
    // Function name rides in the id token as `functions.NAME:IDX`. Some
    // models degrade it to an opaque id (observed: `chatcmpl-tool-<hex>`),
    // which leaves no way to know WHICH tool was meant — unparseable.
    const nameMatch = /^functions\.([A-Za-z0-9_.-]+):\d+$/.exec(idToken);
    const name = nameMatch?.[1];
    let argsOk = false;
    if (extracted && name && isKnownTool(name, toolNames)) {
      try { JSON.parse(extracted.json); argsOk = true; } catch { /* fall through */ }
      if (argsOk) calls.push({ name, arguments: extracted.json });
    }
    if (!argsOk) parsedAll = false;
    const endTag = clean.indexOf('<|tool_call_end|>', extracted?.end ?? argStart);
    spans.push({ from: m.index, to: endTag === -1 ? (extracted?.end ?? argStart) : endTag + '<|tool_call_end|>'.length });
  }
  for (const s of [...spans].reverse()) clean = clean.slice(0, s.from) + clean.slice(s.to);
  return { calls: parsedAll && calls.length > 0 ? calls : null, cleanText: clean.trim() };
}

/** Dialect 2: <function=NAME{...}</function> (with or without a '>' after the name). */
function parseFunctionTagDialect(text: string, toolNames: Set<string>): { calls: RescuedToolCall[] | null; cleanText: string } {
  const calls: RescuedToolCall[] = [];
  let clean = text;
  let parsedAll = true;
  const headRe = /<function=([A-Za-z0-9_.-]+)\s*>?\s*/g;
  let m: RegExpExecArray | null;
  const spans: Array<{ from: number; to: number }> = [];
  while ((m = headRe.exec(text)) !== null) {
    const name = m[1];
    const afterHead = m.index + m[0].length;
    const jsonStart = text[afterHead] === '{' || text[afterHead] === '['
      ? afterHead
      : text.indexOf('{', afterHead);
    const extracted = jsonStart === -1 ? null : extractBalancedJson(text, jsonStart);
    let ok = false;
    if (extracted && isKnownTool(name, toolNames) && extracted.json.startsWith('{')) {
      try { JSON.parse(extracted.json); ok = true; } catch { /* fall through */ }
      if (ok) calls.push({ name, arguments: extracted.json });
    }
    if (!ok) parsedAll = false; // array-shaped or invalid args: not a callable shape
    const closeTag = text.indexOf('</function>', extracted?.end ?? m.index + m[0].length);
    spans.push({ from: m.index, to: closeTag === -1 ? (extracted?.end ?? m.index + m[0].length) : closeTag + '</function>'.length });
  }
  for (const s of [...spans].reverse()) clean = clean.slice(0, s.from) + clean.slice(s.to);
  return { calls: parsedAll && calls.length > 0 ? calls : null, cleanText: clean.trim() };
}

/** Dialect 3: <tool_call>{...}</tool_call> XML-JSON blocks. */
function parseXmlDialect(text: string, toolNames: Set<string>): { calls: RescuedToolCall[] | null; cleanText: string } {
  const calls: RescuedToolCall[] = [];
  let parsedAll = true;
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  let clean = text;
  const matches: string[] = [];
  while ((m = re.exec(text)) !== null) matches.push(m[1]);
  for (const inner of matches) {
    const call = callFromNamedJson(inner, toolNames);
    if (call) calls.push(call);
    else parsedAll = false;
  }
  clean = clean.replace(re, '');
  // An opening tag with no close (truncated stream) is detected-but-broken.
  if (/<tool_call>/.test(clean)) { parsedAll = false; clean = clean.replace(/<tool_call>[\s\S]*$/, ''); }
  return { calls: parsedAll && calls.length > 0 ? calls : null, cleanText: clean.trim() };
}

/**
 * Dialect 5: Dots XML.
 *   <dots_function_call>
 *     <invoke name="NAME"><parameter name="k">v</parameter></invoke>
 *   </dots_function_call>
 * Each invoke is one call; parameter values go through dotsParamValue. The
 * arguments field is the JSON object, same shape as the other dialects.
 */
/**
 * A dots <parameter> body is plain text. Drop only the line breaks the model
 * puts next to the tags (the value's own spaces matter: Edit's old_string is
 * matched exactly), then give JSON-looking values their JSON type so tools
 * that take numbers, booleans, arrays or objects (Read offset/limit, Edit
 * replace_all, TodoWrite todos) get them in that type. The tool schemas are
 * not available here, so anything else stays a string.
 */
function dotsParamValue(raw: string): unknown {
  const value = raw.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  const t = value.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    try { return JSON.parse(t); } catch { /* not JSON: keep the text */ }
  }
  return value;
}

function parseDotsDialect(text: string, toolNames: Set<string>, tag: 'dots_function_call' | 'function_calls' = 'dots_function_call'): { calls: RescuedToolCall[] | null; cleanText: string } {
  const calls: RescuedToolCall[] = [];
  let parsedAll = true;
  const blockRe = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const spans: Array<{ from: number; to: number }> = [];
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(text)) !== null) {
    spans.push({ from: block.index, to: block.index + block[0].length });
    const invokeRe = /<invoke\s+name\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*>([\s\S]*?)<\/invoke>/g;
    let inv: RegExpExecArray | null;
    let sawInvoke = false;
    while ((inv = invokeRe.exec(block[1])) !== null) {
      sawInvoke = true;
      const name = inv[1] ?? inv[2] ?? inv[3];
      const args: Record<string, unknown> = {};
      const paramRe = /<parameter\s+name\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*>([\s\S]*?)<\/parameter>/g;
      let p: RegExpExecArray | null;
      while ((p = paramRe.exec(inv[4] ?? '')) !== null) {
        const key = p[1] ?? p[2] ?? p[3];
        if (!key) { parsedAll = false; continue; }
        args[key] = dotsParamValue(p[4] ?? '');
      }
      if (name && isKnownTool(name, toolNames)) calls.push({ name, arguments: JSON.stringify(args) });
      else parsedAll = false;
    }
    if (!sawInvoke) parsedAll = false;
  }
  let clean = text;
  for (const s of [...spans].reverse()) clean = clean.slice(0, s.from) + clean.slice(s.to);
  // An opening tag with no close (truncated stream) is detected-but-broken.
  const openTag = `<${tag}>`;
  if (clean.includes(openTag)) {
    parsedAll = false;
    clean = clean.slice(0, clean.indexOf(openTag));
  }
  return { calls: parsedAll && calls.length > 0 ? calls : null, cleanText: clean.trim() };
}

/**
 * Rescue inline tool-call dialects out of an assistant text answer.
 *
 * @param text       the assistant message content
 * @param toolNames  the names of the tools the REQUEST declared; rescued
 *                   calls must match one (empty set = accept any name,
 *                   used by tests only)
 */
export function rescueInlineToolCalls(text: string, toolNames: Set<string>): RescueResult {
  if (!text) return { detected: false, calls: null, cleanText: text };

  if (text.includes('<|tool_call_begin|>') || text.includes('<|tool_calls_section_begin|>')) {
    const { calls, cleanText } = parseTokenDialect(text, toolNames);
    return { detected: true, calls, cleanText };
  }
  if (text.includes('<function=')) {
    const { calls, cleanText } = parseFunctionTagDialect(text, toolNames);
    return { detected: true, calls, cleanText };
  }
  if (text.includes('<tool_call>')) {
    const { calls, cleanText } = parseXmlDialect(text, toolNames);
    return { detected: true, calls, cleanText };
  }
  if (text.includes('<dots_function_call>')) {
    const { calls, cleanText } = parseDotsDialect(text, toolNames);
    return { detected: true, calls, cleanText };
  }
  if (text.includes('<function_calls>')) {
    const { calls, cleanText } = parseDotsDialect(text, toolNames, 'function_calls');
    return { detected: true, calls, cleanText };
  }

  // Dialect 4: the entire answer is one JSON object naming a known tool —
  // either bare or inside a ```json fence. Strictly schema-gated.
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    const call = callFromNamedJson(candidate, toolNames);
    // Only treat as dialect when it actually names a requested tool;
    // arbitrary JSON answers must pass through untouched.
    if (call) return { detected: true, calls: [call], cleanText: '' };
  }

  return { detected: false, calls: null, cleanText: text };
}
