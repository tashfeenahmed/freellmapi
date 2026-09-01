import { z } from 'zod';
import { registerEngine } from '../registry.js';
import { hasProtectedSpan } from '../preservation.js';
import { textContent, withTextContent } from '../helpers.js';
import { BUILTIN_FILTERS, type ToolFilterRule } from './filter-definitions.js';
import { loadCustomFilters } from './custom-filters.js';
import type { CompressionEngine, ToolCallOrigin } from '../types.js';

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
export const ERROR_GUARD_RE = /\b(?:error|exception|fatal|failed|failure|traceback|panic|assert(?:ion)?|not ok|✗|×)\b/i;

function safeRegex(source: string, flags = 'i'): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function matches(rule: ToolFilterRule, content: string, origin?: ToolCallOrigin): boolean {
  if (rule.id === 'fallback') return true;
  const name = origin?.name.toLowerCase();
  if (name && rule.detect.toolNames.some(candidate => candidate.toLowerCase() === name)) {
    if (rule.detect.content.length === 0) return true;
    // Generic shell tools still need content-shape detection.
  }
  return rule.detect.content.some(pattern => safeRegex(pattern, 'im')?.test(content));
}

function rawMustKeep(line: string): boolean {
  return ERROR_GUARD_RE.test(line) || hasProtectedSpan(line);
}

// One protected-span scan per distinct line per rule application; the same
// line is otherwise re-scanned by every filtering stage.
let mustKeepCache = new Map<string, boolean>();

function mustKeep(line: string): boolean {
  const cached = mustKeepCache.get(line);
  if (cached !== undefined) return cached;
  const result = rawMustKeep(line);
  mustKeepCache.set(line, result);
  return result;
}

function collapseRuns(lines: string[], minimum: number): string[] {
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const count = end - index;
    if (count >= minimum && !mustKeep(lines[index])) {
      output.push(lines[index], `[… ${count - 2} identical lines omitted …]`, lines[end - 1]);
    } else {
      output.push(...lines.slice(index, end));
    }
    index = end;
  }
  return output;
}

function selectHeadTail(lines: string[], head: number, tail: number): string[] {
  if (lines.length <= head + tail) return lines;
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(head, lines.length); index += 1) selected.add(index);
  for (let index = Math.max(0, lines.length - tail); index < lines.length; index += 1) selected.add(index);
  lines.forEach((line, index) => { if (mustKeep(line)) selected.add(index); });
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (selected.has(index)) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && !selected.has(index)) index += 1;
    output.push(`[… ${index - start} lines omitted …]`);
  }
  return output;
}

const OMISSION_MARKER_RE = /^\[… \d+ (?:lines|identical lines) omitted …\]$/;

function enforceMaxChars(lines: string[], maxChars: number): string[] {
  let total = lines.reduce((sum, line) => sum + line.length + 1, -1);
  if (lines.length <= 2 || total <= maxChars) return lines;
  // Rank removable lines center-out once, then delete in a single pass —
  // recomputing joined length per removal is quadratic on large outputs.
  const middle = (lines.length - 1) / 2;
  const removable = lines
    .map((line, index) => ({ line, index, distance: Math.abs(index - middle) }))
    .filter(({ line }) => !mustKeep(line) && !OMISSION_MARKER_RE.test(line))
    .sort((a, b) => a.distance - b.distance);
  const removed = new Set<number>();
  for (const { line, index } of removable) {
    if (total <= maxChars || lines.length - removed.size <= 2) break;
    removed.add(index);
    total -= line.length + 1;
  }
  if (removed.size === 0) return lines;
  return lines.filter((_line, index) => !removed.has(index));
}

function applyRule(
  content: string,
  rule: ToolFilterRule,
  intensity: 'minimal' | 'standard' | 'aggressive',
  configuredMaxLines: number,
  configuredMaxChars: number,
): string {
  mustKeepCache = new Map();
  let lines = (rule.stripAnsi ? content.replace(ANSI_RE, '') : content).split('\n');
  // Compile every rule pattern once, not once per line.
  const dropPatterns = rule.dropLines
    .map(drop => ({
      pattern: safeRegex(drop.pattern),
      unless: drop.unless ? safeRegex(drop.unless) : null,
    }))
    .filter((drop): drop is { pattern: RegExp; unless: RegExp | null } => drop.pattern != null);
  const keepPatterns = rule.keepLines
    .map(pattern => safeRegex(pattern))
    .filter((pattern): pattern is RegExp => pattern != null);
  lines = lines.filter(line => {
    if (mustKeep(line)) return true;
    for (const drop of dropPatterns) {
      if (!drop.pattern.test(line)) continue;
      if (!drop.unless || !drop.unless.test(line)) return false;
    }
    if (rule.keepLines.length > 0) {
      return keepPatterns.some(pattern => pattern.test(line));
    }
    return true;
  });
  if (rule.collapseRuns) lines = collapseRuns(lines, rule.collapseRuns.min);
  const budgets = {
    minimal: { head: 50, tail: 35 },
    standard: { head: 30, tail: 20 },
    aggressive: { head: 15, tail: 15 },
  }[intensity];
  const maxLines = Math.max(10, configuredMaxLines);
  if (rule.headTail && lines.length > maxLines) {
    const ratio = Math.min(1, maxLines / (budgets.head + budgets.tail));
    lines = selectHeadTail(
      lines,
      Math.max(5, Math.floor(budgets.head * ratio)),
      Math.max(5, Math.floor(budgets.tail * ratio)),
    );
  }
  lines = enforceMaxChars(lines, Math.min(configuredMaxChars, rule.maxChars ?? Infinity));
  const result = lines.join('\n');
  // Stats and caches must not retain request content after the call.
  mustKeepCache = new Map();
  return result;
}

const toolFilterEngine: CompressionEngine = {
  id: 'toolfilter',
  priority: 10,
  lossless: false,
  targets: ['tool-results'],
  configSchema: z.object({
    enabled: z.boolean(),
    intensity: z.enum(['minimal', 'standard', 'aggressive']).default('standard'),
    maxLinesPerResult: z.number().int().positive().default(120),
    maxCharsPerResult: z.number().int().positive().default(12_000),
    disabledFilters: z.array(z.string()).default([]),
  }).passthrough(),
  apply({ messages, config, context }) {
    const intensity = config.intensity === 'minimal' || config.intensity === 'aggressive'
      ? config.intensity
      : 'standard';
    const maxLines = typeof config.maxLinesPerResult === 'number' ? config.maxLinesPerResult : 120;
    const maxChars = typeof config.maxCharsPerResult === 'number' ? config.maxCharsPerResult : 12_000;
    const disabled = new Set(Array.isArray(config.disabledFilters) ? config.disabledFilters.filter(v => typeof v === 'string') : []);
    const rules = [
      ...loadCustomFilters(Boolean((config as Record<string, unknown>).trustProjectFilters)),
      ...BUILTIN_FILTERS,
    ].filter(rule => !disabled.has(rule.id));
    const filtersApplied: Record<string, number> = {};
    const output = messages.map((message, index) => {
      const content = textContent(message);
      if (message.role !== 'tool' || content == null || context.frozenMessageIndexes.has(index)) return message;
      const origin = message.tool_call_id ? context.toolCallOrigins.get(message.tool_call_id) : undefined;
      const rule = rules.find(candidate => matches(candidate, content, origin));
      if (!rule) return message;
      const next = applyRule(content, rule, intensity, maxLines, maxChars);
      if (next.length >= content.length) return message;
      filtersApplied[rule.id] = (filtersApplied[rule.id] ?? 0) + 1;
      return withTextContent(message, next);
    });
    return { messages: output, details: { filtersApplied } };
  },
};

registerEngine(toolFilterEngine);
