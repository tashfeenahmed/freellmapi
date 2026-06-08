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

const isKnownTool = (name: string, toolNames: Set<string>): boolean =>
  toolNames.size === 0 || toolNames.has(name);

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
