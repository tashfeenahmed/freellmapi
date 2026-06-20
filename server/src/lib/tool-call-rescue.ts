export interface RescuedToolCall {
  name: string;
  arguments: string;
}

export function startsWithDialectMarker(text: string): boolean {
  return /```|<tool_call>|<function_call>/i.test(text.trimStart().slice(0, 32));
}

export function couldBecomeDialectMarker(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length < 32 && ('```<tool_call><function_call>'.startsWith(trimmed) || startsWithDialectMarker(trimmed));
}

export function containsDialectMarker(text: string): boolean {
  return /```|<tool_call>|<function_call>/i.test(text);
}

export function rescueInlineToolCalls(text: string, _toolNames: Set<string>): {
  detected: boolean;
  calls: RescuedToolCall[] | null;
  cleanText: string;
} {
  if (!containsDialectMarker(text)) {
    return { detected: false, calls: null, cleanText: text };
  }
  return { detected: true, calls: null, cleanText: text };
}
