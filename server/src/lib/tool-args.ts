// Schema-aware repair of double-encoded tool-call arguments.
//
// Several free-tier models (GLM family prominently) emit NESTED JSON inside
// tool arguments as a string: `{"plan": "[{\"step\":...}]"}` instead of
// `{"plan": [{"step":...}]}`. Strict clients reject the call — observed in
// production as Codex `failed to parse function arguments: invalid type:
// string ..., expected a sequence`, which killed the agent turn right at its
// status-update call. The gateway has the request's tool schemas, so it can
// repair this principled-ly: only when the schema says a parameter is an
// array/object AND the string value parses to exactly that JSON type. A
// parameter whose schema says "string" is never touched, even if it looks
// like JSON.
//
// Also handles whole-arguments double encoding (the arguments field itself
// being a JSON-encoded string of a JSON object), which needs no schema.

interface JsonSchemaish {
  type?: string;
  properties?: Record<string, JsonSchemaish>;
}

/**
 * Repair a tool call's `arguments` JSON string against the tool's parameter
 * schema. Returns the original string untouched whenever anything doesn't
 * parse or doesn't match — this must never corrupt a valid call.
 */
export function repairToolArguments(args: string, paramSchema?: JsonSchemaish): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }

  let changed = false;

  // Whole-arguments double encoding: `"{\"a\":1}"` parses to a string that is
  // itself JSON of an object. Unwrap one level.
  if (typeof parsed === 'string') {
    try {
      const inner = JSON.parse(parsed);
      if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
        parsed = inner;
        changed = true;
      } else {
        return args;
      }
    } catch {
      return args;
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return changed ? JSON.stringify(parsed) : args;
  }

  const props = paramSchema?.properties;
  if (props) {
    const obj = parsed as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string') continue;
      const want = props[key]?.type;
      if (want !== 'array' && want !== 'object') continue;
      const trimmed = value.trim();
      if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) continue;
      try {
        const inner = JSON.parse(trimmed);
        const isMatch = want === 'array'
          ? Array.isArray(inner)
          : inner !== null && typeof inner === 'object' && !Array.isArray(inner);
        if (isMatch) {
          obj[key] = inner;
          changed = true;
        }
      } catch {
        // Not actually JSON — leave the string alone.
      }
    }
  }

  return changed ? JSON.stringify(parsed) : args;
}

/**
 * Recursively remove the given keys from a JSON-Schema-ish value. Used to drop
 * fields a provider's tool-schema validator rejects with a 400 even though they
 * carry no meaning for the call — Cohere's compat endpoint, for instance, 400s
 * on `additionalProperties` (and `$schema`), which strict clients like opencode
 * and continue.dev routinely emit. Returns a NEW value; never mutates the input
 * (tools are shared across the fallback chain, so an in-place strip on one
 * provider would corrupt the schema the next provider sees). Non-object values
 * pass through unchanged. This is the provider-agnostic sibling of google.ts's
 * `sanitizeForGemini`, which strips a much larger Gemini-specific key set.
 */
export function stripSchemaKeys<T>(schema: T, keys: Set<string>): T {
  if (Array.isArray(schema)) {
    return schema.map((s) => stripSchemaKeys(s, keys)) as unknown as T;
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (keys.has(k)) continue;
      out[k] = stripSchemaKeys(v, keys);
    }
    return out as unknown as T;
  }
  return schema;
}

/**
 * Build a tool-name → parameter-schema map from an OpenAI-style tools array
 * (chat-completions shape: {type:'function', function:{name, parameters}}).
 */
export function toolSchemaMap(
  tools?: Array<{ type?: string; function?: { name?: string; parameters?: unknown } }>,
): Map<string, JsonSchemaish> {
  const map = new Map<string, JsonSchemaish>();
  for (const t of tools ?? []) {
    const name = t.function?.name;
    if (t.type === 'function' && name && t.function?.parameters && typeof t.function.parameters === 'object') {
      map.set(name, t.function.parameters as JsonSchemaish);
    }
  }
  return map;
}
