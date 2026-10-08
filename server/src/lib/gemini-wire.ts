import type {
  ChatContentBlock,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import type { ReasoningEffort, ResponseFormat } from './sampling-params.js';
import type { InboundChatResult } from './inbound-chat.js';

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name?: string; response?: unknown };
  thoughtSignature?: string;
  [key: string]: unknown;
}

export interface GeminiContent {
  role?: 'user' | 'model';
  parts?: GeminiPart[];
}

export interface GeminiInboundRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts?: GeminiPart[] };
  tools?: Array<{ functionDeclarations?: Array<{
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    // Newer @google/genai clients (incl. Gemini CLI's MCP tool path) send
    // plain JSON Schema under this alternative field instead of `parameters`.
    parametersJsonSchema?: Record<string, unknown>;
  }> }>;
  toolConfig?: {
    functionCallingConfig?: {
      mode?: string;
      allowedFunctionNames?: string[];
    };
  };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
    responseJsonSchema?: Record<string, unknown>;
    thinkingConfig?: { thinkingBudget?: number };
  };
}

// Gemini-native clients write schemas in the API's OpenAPI-flavored dialect:
// Type enum casing ("OBJECT", "STRING") and `nullable: true`. OpenAI-style
// strict json_schema validators reject both, so normalize the inbound
// direction (the outbound direction has sanitizeForGemini).
const GEMINI_TYPE_ENUM = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']);

export function normalizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  let nullable = false;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'nullable') {
      nullable = value === true;
      continue;
    }
    if (key === 'type' && typeof value === 'string' && GEMINI_TYPE_ENUM.has(value.toLowerCase())) {
      out.type = value.toLowerCase();
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, normalizeGeminiSchema(child)]),
      );
      continue;
    }
    out[key] = normalizeGeminiSchema(value);
  }
  if (nullable && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment',
  'definitions',
  'exclusiveMinimum', 'exclusiveMaximum',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'if', 'then', 'else',
  'contentEncoding', 'contentMediaType', 'contentSchema',
  'dependentRequired', 'dependentSchemas', 'dependencies',
  'additionalProperties',
  'examples', 'const', 'readOnly', 'writeOnly',
  'uniqueItems',
  'not', 'allOf', 'oneOf',
  'prefixItems',
  'contains', 'minContains', 'maxContains',
  'propertyNames',
  'multipleOf',
  'deprecated',
]);

const VENDOR_EXTENSION_SCHEMA_KEY = /^x-/i;

// Google's Schema proto types `type` as a single enum, but OpenAI-style
// clients emit JSON Schema unions (`.nullable()` builders produce
// `"type": ["number", "null"]`), which 400s with "Proto field is not
// repeating, cannot start list". Collapse the union to its first concrete
// member plus Gemini's own `nullable` flag — the inverse of what
// normalizeGeminiSchema does on the inbound direction.
interface CollapsedType {
  type?: string;
  nullable: boolean;
}

function collapseTypeUnion(value: unknown[]): CollapsedType {
  const names = value.filter((entry): entry is string => typeof entry === 'string');
  const nullable = names.some(name => name.toLowerCase() === 'null');
  // A union of two concrete types has no Gemini equivalent; keeping the first
  // is lossy but still describes the argument, where dropping `type` entirely
  // would let the model emit anything.
  const concrete = names.find(name => name.toLowerCase() !== 'null');
  return { type: concrete, nullable };
}

// Best-effort JSON pointer resolution against the schema root, so a `$ref`
// into `$defs`/`definitions` keeps its structure instead of collapsing to a
// permissive `{}`. Anything else (remote refs, missing targets) still falls
// back to dropping the keyword, like the other unsupported keywords do.
function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    const segment = decodeURIComponent(rawSegment).replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

interface SanitizeContext {
  root: unknown;
  // Refs expanded on the current path, so a self-referential definition drops
  // out instead of recursing forever.
  expanding: ReadonlySet<string>;
}

export function sanitizeForGemini(schema: unknown): unknown {
  return sanitizeSchema(schema, false, { root: schema, expanding: new Set() });
}

function sanitizeSchema(schema: unknown, insidePropertiesMap: boolean, ctx: SanitizeContext): unknown {
  if (Array.isArray(schema)) return schema.map(value => sanitizeSchema(value, false, ctx));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  let nullable = false;
  let inlined: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (insidePropertiesMap) {
      out[key] = sanitizeSchema(value, false, ctx);
      continue;
    }
    if (key === '$ref' && typeof value === 'string' && !ctx.expanding.has(value)) {
      const target = resolvePointer(ctx.root, value);
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        inlined = sanitizeSchema(target, false, {
          root: ctx.root,
          expanding: new Set([...ctx.expanding, value]),
        }) as Record<string, unknown>;
      }
      continue;
    }
    if (key === 'type' && Array.isArray(value)) {
      const collapsed = collapseTypeUnion(value);
      if (collapsed.type !== undefined) out.type = collapsed.type;
      nullable = nullable || collapsed.nullable;
      continue;
    }
    if (!UNSUPPORTED_SCHEMA_KEYS.has(key) && !VENDOR_EXTENSION_SCHEMA_KEY.test(key)) {
      out[key] = sanitizeSchema(value, key === 'properties', ctx);
    }
  }
  if (nullable) out.nullable = true;
  // Keywords written alongside a `$ref` (description, overrides) win over the
  // definition they point at.
  const merged = inlined ? { ...inlined, ...out } : out;
  // A `properties` map is keyed by parameter names, not keywords; a tool
  // param literally named `items` or `type` must not be read as a schema.
  if (insidePropertiesMap) return merged;
  return normalizeArrayItems(merged, schema as Record<string, unknown>, ctx);
}

// Gemini's Schema proto models `items` as a single Schema message and requires
// it on every ARRAY: an array without `items` 400s with "…items: missing
// field" (#1334 — Claude Code's nested tuple params lose their element schema
// once `prefixItems` is stripped), and a JSON Schema tuple (`items: [...]`)
// 400s with "Proto field is not repeating". Tuples become an `anyOf` over their
// members, and an array with no usable element schema gets `items: {}`, which
// Gemini accepts as "any element" (both verified against the live API).
function normalizeArrayItems(
  merged: Record<string, unknown>,
  source: Record<string, unknown>,
  ctx: SanitizeContext,
): Record<string, unknown> {
  const members: unknown[] = [];
  if (Array.isArray(source.prefixItems)) {
    members.push(...(sanitizeSchema(source.prefixItems, false, ctx) as unknown[]));
  }
  let single: Record<string, unknown> | undefined;
  if (Array.isArray(merged.items)) members.push(...merged.items);
  else if (isSchemaObject(merged.items)) single = merged.items;

  if (members.length > 0) {
    const branches = [...members, ...(single ? [single] : [])];
    if (branches.every(isSchemaObject) && branches.every(b => Object.keys(b).length > 0)) {
      merged.items = branches.length === 1 ? branches[0] : { anyOf: branches };
    } else {
      // A boolean/empty member accepts anything, so the union does too.
      merged.items = {};
    }
  } else if (single === undefined && ('items' in merged || isArrayType(merged.type))) {
    merged.items = {};
  }
  return merged;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isArrayType(type: unknown): boolean {
  return typeof type === 'string' && type.toLowerCase() === 'array';
}

function serializeResponse(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function systemText(system?: GeminiInboundRequest['systemInstruction']): string {
  return (system?.parts ?? [])
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

export function geminiContentsToMessages(body: GeminiInboundRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // FIFO per name: parallel calls to the same tool without client-echoed ids
  // must each consume their own synthesized id, or one call is left without a
  // response and strict upstreams reject the history.
  const pendingCallIdsByName = new Map<string, string[]>();
  const system = systemText(body.systemInstruction);
  if (system) messages.push({ role: 'system', content: system });

  for (const content of body.contents ?? []) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const textBlocks: ChatContentBlock[] = [];
    const calls: ChatToolCall[] = [];
    const functionResponses: GeminiPart[] = [];

    for (const part of content.parts ?? []) {
      // Thought summaries kept in client history are not conversation content.
      if (typeof part.text === 'string' && part.thought !== true) {
        textBlocks.push({ type: 'text', text: part.text });
      }
      const inline = part.inlineData ?? (
        part.inline_data
          ? { mimeType: part.inline_data.mime_type, data: part.inline_data.data }
          : undefined
      );
      if (inline?.mimeType && inline.data) {
        textBlocks.push({
          type: 'image_url',
          image_url: { url: `data:${inline.mimeType};base64,${inline.data}` },
        });
      }
      if (part.functionCall?.name) {
        const id = part.functionCall.id || `call_${messages.length}_${calls.length}`;
        calls.push({
          id,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: typeof part.functionCall.args === 'string'
              ? part.functionCall.args
              : JSON.stringify(part.functionCall.args ?? {}),
          },
          ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
        });
        const queue = pendingCallIdsByName.get(part.functionCall.name) ?? [];
        queue.push(id);
        pendingCallIdsByName.set(part.functionCall.name, queue);
      }
      if (part.functionResponse?.name) functionResponses.push(part);
    }

    if (role === 'assistant') {
      messages.push({
        role,
        content: textBlocks.length ? textBlocks : null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    }

    // Tool results answer the preceding assistant tool_calls; they must come
    // before any new user text or strict upstreams reject the ordering.
    for (const part of functionResponses) {
      const response = part.functionResponse!;
      messages.push({
        role: 'tool',
        tool_call_id: response.id || pendingCallIdsByName.get(response.name!)?.shift()
          || `call_${messages.length}`,
        name: response.name,
        content: serializeResponse(response.response),
      });
    }

    if (role !== 'assistant' && (textBlocks.length || functionResponses.length === 0)) {
      messages.push({
        role: 'user',
        content: textBlocks.length ? textBlocks : '',
      });
    }
  }
  return messages;
}

export function geminiToolsToChatTools(
  tools: GeminiInboundRequest['tools'],
): ChatToolDefinition[] | undefined {
  const declarations = (tools ?? []).flatMap(tool => tool.functionDeclarations ?? []);
  const converted = declarations
    .filter(declaration => !!declaration.name)
    .map(declaration => ({
      type: 'function' as const,
      function: {
        name: declaration.name!,
        description: declaration.description,
        parameters: normalizeGeminiSchema(
          declaration.parameters
            ?? declaration.parametersJsonSchema
            ?? { type: 'object', properties: {} },
        ) as Record<string, unknown>,
      },
    }));
  return converted.length ? converted : undefined;
}

export function geminiToolChoice(config: GeminiInboundRequest['toolConfig']): ChatToolChoice | undefined {
  const fc = config?.functionCallingConfig;
  const mode = fc?.mode?.toUpperCase();
  // No toolConfig at all must map to undefined: emitting tool_choice on a
  // tool-free request 400s on strict OpenAI-compatible upstreams.
  if (!mode) return undefined;
  if (mode === 'AUTO') return 'auto';
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY') {
    const name = fc?.allowedFunctionNames?.[0];
    return name ? { type: 'function', function: { name } } : 'required';
  }
  return undefined;
}

export function geminiResponseFormat(
  config: GeminiInboundRequest['generationConfig'],
): ResponseFormat | undefined {
  if (config?.responseMimeType !== 'application/json') return undefined;
  const schema = config.responseSchema ?? config.responseJsonSchema;
  if (schema) {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'gemini_response',
        schema: normalizeGeminiSchema(schema) as Record<string, unknown>,
      },
    };
  }
  return { type: 'json_object' };
}

export function effortFromGeminiThinking(
  config: GeminiInboundRequest['generationConfig'],
): ReasoningEffort | undefined {
  const budget = config?.thinkingConfig?.thinkingBudget;
  if (budget == null) return undefined;
  // -1 is the API's "dynamic thinking" (model-managed budget) and is Gemini
  // CLI's default — leave the provider default in place rather than disabling.
  if (budget < 0) return undefined;
  if (budget === 0) return 'none';
  if (budget < 4096) return 'low';
  if (budget < 16384) return 'medium';
  return 'high';
}

export function geminiFinishReason(
  finishReason: string | null,
  hasToolCalls = false,
): string {
  if (hasToolCalls) return 'STOP';
  switch ((finishReason ?? '').toLowerCase()) {
    case 'length':
      return 'MAX_TOKENS';
    case 'content_filter':
      return 'SAFETY';
    default:
      return 'STOP';
  }
}

export function geminiPartsFromResult(result: Pick<InboundChatResult, 'text' | 'reasoning' | 'toolCalls'>): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (result.reasoning) parts.push({ text: result.reasoning, thought: true });
  if (result.text) parts.push({ text: result.text });
  for (const call of result.toolCalls) {
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      args = { value: call.function.arguments };
    }
    parts.push({
      functionCall: {
        id: call.id,
        name: call.function.name,
        args,
      },
      ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}),
    });
  }
  return parts;
}

export function geminiResponseFromResult(result: InboundChatResult): Record<string, unknown> {
  return {
    candidates: [{
      content: { role: 'model', parts: geminiPartsFromResult(result) },
      finishReason: geminiFinishReason(result.finishReason, result.toolCalls.length > 0),
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: result.promptTokens,
      candidatesTokenCount: result.completionTokens,
      totalTokenCount: result.promptTokens + result.completionTokens,
    },
    modelVersion: result.route.modelId,
  };
}

// Gemini bills images at a fixed per-tile cost; counting their base64 length
// as text overreports by orders of magnitude and triggers premature client
// context compression.
const GEMINI_IMAGE_TOKENS = 258;

export function estimateGeminiTokens(
  body: Pick<GeminiInboundRequest, 'contents' | 'systemInstruction' | 'tools'>,
): number {
  let tokens = Math.ceil(systemText(body.systemInstruction).length / 4);
  for (const content of body.contents ?? []) {
    for (const part of content.parts ?? []) {
      if (typeof part.text === 'string') tokens += Math.ceil(part.text.length / 4);
      if (part.inlineData?.data || part.inline_data?.data) tokens += GEMINI_IMAGE_TOKENS;
      if (part.functionCall) tokens += Math.ceil(JSON.stringify(part.functionCall).length / 4);
      if (part.functionResponse) tokens += Math.ceil(JSON.stringify(part.functionResponse).length / 4);
    }
  }
  if (body.tools?.length) tokens += Math.ceil(JSON.stringify(body.tools).length / 4);
  return tokens;
}
