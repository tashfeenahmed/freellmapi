// Structured-output enforcement for the fallback chain (#514 follow-up).
//
// Forwarding response_format is necessary but not sufficient: a free-tier
// model that doesn't understand JSON mode often just answers in prose (or
// wraps the JSON in a markdown fence) and the request LOOKS successful — the
// worst failure mode, because the client asked for machine-readable output
// and got an essay. On non-streaming responses the gateway can check, heal,
// or fail over:
//
//   1. content parses as JSON            → pass through untouched
//   2. content wraps JSON in ```fences``` or leading/trailing prose
//                                        → heal: replace content with the JSON
//   3. nothing parseable                 → retryable failure (skipBench: the
//      provider is healthy, the MODEL ignored the format — no cooldown, no
//      penalty; the chain just tries the next candidate)
//
// Streaming responses can't be retro-checked (bytes are already on the wire),
// so enforcement is non-stream only — same boundary as the response cache.

export type JsonEnforcement =
  | { ok: true; content: string; healed: boolean }
  | { ok: false };

/** Match a fenced code block (```json ... ``` or bare ``` ... ```). */
const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)```/i;

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Slice from the first '{' or '[' to the matching last '}' or ']'. */
function outermostJsonSlice(text: string): string | null {
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  const first = firstObj === -1 ? firstArr : (firstArr === -1 ? firstObj : Math.min(firstObj, firstArr));
  if (first === -1) return null;
  const open = text[first];
  const close = open === '{' ? '}' : ']';
  const last = text.lastIndexOf(close);
  if (last <= first) return null;
  return text.slice(first, last + 1);
}

export function enforceJsonContent(content: string): JsonEnforcement {
  const trimmed = content.trim();
  if (trimmed.length === 0) return { ok: false };

  if (parses(trimmed)) return { ok: true, content: trimmed === content ? content : trimmed, healed: trimmed !== content };

  // Fenced block: the most common "almost right" shape free models produce.
  const fence = FENCE_RE.exec(trimmed);
  if (fence) {
    const inner = fence[1].trim();
    if (parses(inner)) return { ok: true, content: inner, healed: true };
  }

  // Leading/trailing prose around one JSON value ("Here is your JSON: {...}").
  const slice = outermostJsonSlice(trimmed);
  if (slice && parses(slice)) return { ok: true, content: slice, healed: true };

  return { ok: false };
}
