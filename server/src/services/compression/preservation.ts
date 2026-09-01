export type ProtectedKind =
  | 'fenced-code'
  | 'inline-code'
  | 'url'
  | 'path'
  | 'json-key'
  | 'number'
  | 'stack-trace'
  | 'diff-hunk'
  | 'key-value'
  | 'error'
  | 'constraint';

export interface ProtectedSpan {
  start: number;
  end: number;
  text: string;
  kinds: ProtectedKind[];
}

const RULES: Array<{ kind: ProtectedKind; regex: RegExp }> = [
  { kind: 'fenced-code', regex: /```[\s\S]*?```/g },
  { kind: 'inline-code', regex: /`[^`\n]+`/g },
  { kind: 'url', regex: /\bhttps?:\/\/[^\s<>()]+/gi },
  { kind: 'path', regex: /(?:\b[A-Za-z]:\\(?:[^\\\s:"<>|?*]+\\)*[^\\\s:"<>|?*]*|\B~?\/(?:[\w.@%+~=-]+\/)*[\w.@%+~=-]+|\B\.{1,2}\/(?:[\w.@%+~=-]+\/)*[\w.@%+~=-]+)/g },
  { kind: 'json-key', regex: /"(?:\\.|[^"\\])+"\s*:/g },
  { kind: 'number', regex: /(?<![\w])[-+]?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)(?![\w])/g },
  { kind: 'stack-trace', regex: /^\s*at\s+.+$/gm },
  { kind: 'diff-hunk', regex: /^@@[^\n]*@@[^\n]*$/gm },
  { kind: 'key-value', regex: /\b[A-Za-z_][A-Za-z0-9_.-]*=(?:"[^"]*"|'[^']*'|[^\s]+)/g },
  { kind: 'error', regex: /^.*\b(?:error|exception|fatal|failed|failure|traceback|panic)\b.*$/gim },
  {
    kind: 'constraint',
    regex:
      /^.*\b(?:must(?:\s+not)?|do\s+not|don't|never|always|require(?:d|ment|ments)?|constraint|important|warning|security|permission|authorization|forbidden|prohibited)\b.*$/gim,
  },
];

export function mergeProtectedSpans(spans: ProtectedSpan[]): ProtectedSpan[] {
  const ordered = spans
    .filter(span => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: ProtectedSpan[] = [];
  for (const span of ordered) {
    const previous = merged[merged.length - 1];
    if (!previous || span.start > previous.end) {
      merged.push({ ...span, kinds: [...new Set(span.kinds)] });
      continue;
    }
    previous.end = Math.max(previous.end, span.end);
    previous.kinds = [...new Set([...previous.kinds, ...span.kinds])];
  }
  return merged;
}

export function scanProtectedSpans(text: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      if (match.index == null || !match[0]) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        kinds: [rule.kind],
      });
    }
  }
  return mergeProtectedSpans(spans).map(span => ({ ...span, text: text.slice(span.start, span.end) }));
}

export function transformUnprotectedText(text: string, transform: (part: string) => string): string {
  const spans = scanProtectedSpans(text);
  if (spans.length === 0) return transform(text);
  const placeholders: string[] = [];
  let masked = '';
  let cursor = 0;
  spans.forEach((span, index) => {
    const placeholder = `\uE000${index.toString(36)}\uE001`;
    placeholders.push(text.slice(span.start, span.end));
    masked += text.slice(cursor, span.start);
    masked += placeholder;
    cursor = span.end;
  });
  masked += text.slice(cursor);
  // Restore in one pass \u2014 a per-placeholder `.replace()` rescans the whole
  // string each time and turns span-heavy text quadratic.
  return transform(masked).replace(
    /\uE000([0-9a-z]+)\uE001/g,
    (match, index: string) => placeholders[Number.parseInt(index, 36)] ?? match,
  );
}

/**
 * Boolean-only fast path: true when any rule matches, WITHOUT collecting,
 * sorting or merging the spans. Equivalent to `scanProtectedSpans(text).length > 0`
 * (none of the rules can match the empty string — every pattern requires at
 * least one character), but it exits on the first hit instead of building the
 * full span list. The per-line callers (toolfilter's `mustKeep`,
 * `protectedLines`, hard-budget, relevance) were paying the full
 * collect + sort + merge cost just to answer a yes/no question; on a
 * 20k-line adversarial payload that is the difference between the
 * compression regression test sitting under and over its budget on slow
 * hardware.
 */
export function hasProtectedSpan(text: string): boolean {
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) return true;
  }
  return false;
}

export function hasProtectedContent(text: string): boolean {
  return hasProtectedSpan(text);
}

export function protectedLines(text: string): string[] {
  return text.split('\n').filter(line => hasProtectedSpan(line));
}

export function extractProtectedValues(text: string, kind?: ProtectedKind): string[] {
  const values: string[] = [];
  if (!kind) return scanProtectedSpans(text).map(span => span.text);
  const rule = RULES.find(entry => entry.kind === kind);
  if (!rule) return values;
  rule.regex.lastIndex = 0;
  for (const match of text.matchAll(rule.regex)) {
    if (match[0]) values.push(match[0]);
  }
  return values;
}
