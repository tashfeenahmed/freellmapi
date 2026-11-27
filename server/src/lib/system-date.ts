import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getSetting, setSetting } from '../db/index.js';
import { contentToString } from './content.js';

export interface ToolLike {
  type?: string;
  function?: { name?: string };
}

// Opt-in system-date injection (#1931).
//
// Open-source models often lack awareness of the current date, causing stale
// queries when paired with web search (e.g. searching for 2024 data on "latest"
// questions). At the same time, unconditionally mutating every prompt hurts
// provider-side prompt caching and collides with coding agents that already
// inject their own date.
//
// Three modes give operators the right trade-off:
//   - 'off'        (default): untouched prompts; maximum cache stability.
//   - 'web_search': inject only when the request carries a web-search tool or
//                   Playground web-search context.
//   - 'always':     inject on every chat request.
//
// Format is date-only (`YYYY-MM-DD (UTC)`) rather than HH:MM:SS so provider
// prompt caches remain valid for the full UTC day, and injection is skipped
// automatically whenever a system/developer message already states the date.

export const SYSTEM_DATE_SETTING = 'inject_system_date';
export const SYSTEM_DATE_MODES = ['off', 'web_search', 'always'] as const;
export type SystemDateMode = (typeof SYSTEM_DATE_MODES)[number];

const WEB_SEARCH_TOOL_NAME_RE =
  /^(?:web[_-]?search|search[_-]?web|internet[_-]?search|google[_-]?search|tavily[_-]?search|brave[_-]?search|exa[_-]?search|duckduckgo[_-]?search)(?:_\d{4}_\d{2}_\d{2})?$/i;

const WEB_SEARCH_TOOL_TYPE_RE = /^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/i;

const EXISTING_DATE_MARKER_RE =
  /(?:\bcurrent\s+(?:date|time)\s*[:=]|today(?:'s)?\s+date\s+is\b|\btoday\s+is\s+\d{4}-\d{2}-\d{2}\b)/i;

function parseSystemDateMode(raw: string | null | undefined): SystemDateMode | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'false' || normalized === '0') return 'off';
  if (normalized === 'web_search' || normalized === 'web-search' || normalized === 'search') return 'web_search';
  if (normalized === 'always' || normalized === 'on' || normalized === 'true' || normalized === '1') return 'always';
  return null;
}

/**
 * Resolve the effective system-date injection mode.
 * Precedence: dashboard setting (`settings.inject_system_date`) >
 * env var (`FREELLMAPI_INJECT_SYSTEM_DATE`) > default `'off'`.
 */
export function getSystemDateMode(): SystemDateMode {
  try {
    const stored = parseSystemDateMode(getSetting(SYSTEM_DATE_SETTING));
    if (stored !== null) return stored;
  } catch {
    // DB may not be initialized yet in isolated unit tests; fall through to env.
  }
  return parseSystemDateMode(process.env.FREELLMAPI_INJECT_SYSTEM_DATE) ?? 'off';
}

export function setSystemDateMode(mode: SystemDateMode): SystemDateMode {
  setSetting(SYSTEM_DATE_SETTING, mode);
  return mode;
}

export function formatSystemDatePrompt(now: Date = new Date()): string {
  const isoDate = now.toISOString().slice(0, 10);
  return `Current date: ${isoDate} (UTC).`;
}

/**
 * True when the request includes a web-search tool (e.g. Claude Code / Codex
 * `web_search`, or an OpenAI function tool named `web_search` / `search_web`)
 * or Playground's injected web-search context (`Web search results for "..."`).
 */
export function hasWebSearchInRequest(
  messages: readonly ChatMessage[],
  tools?: readonly ToolLike[],
): boolean {
  if (tools && tools.length > 0) {
    for (const tool of tools) {
      const rawType = tool?.type;
      if (typeof rawType === 'string' && WEB_SEARCH_TOOL_TYPE_RE.test(rawType)) return true;
      const fnName = tool?.function?.name;
      if (typeof fnName === 'string' && WEB_SEARCH_TOOL_NAME_RE.test(fnName.trim())) return true;
    }
  }
  for (const msg of messages) {
    const role = String(msg.role);
    if (role !== 'system' && role !== 'developer') continue;
    const text = contentToString(msg.content);
    if (text.includes('Web search results for "')) return true;
  }
  return false;
}

/**
 * Skip injection if a leading system/developer prompt already provides the
 * current date (for example, coding agents like Claude Code or replayed turns).
 */
export function alreadyHasDateContext(messages: readonly ChatMessage[]): boolean {
  for (const msg of messages) {
    const role = String(msg.role);
    if (role !== 'system' && role !== 'developer') continue;
    const text = contentToString(msg.content);
    if (EXISTING_DATE_MARKER_RE.test(text)) return true;
  }
  return false;
}

/**
 * Prepend a date-only system message (`Current date: YYYY-MM-DD (UTC).`) when
 * enabled by mode and not already present in the caller's system prompt.
 * Never mutates the caller's array; returns the original reference when no-op.
 */
export function maybeInjectSystemDate(
  messages: ChatMessage[],
  opts: {
    mode?: SystemDateMode;
    tools?: readonly ToolLike[];
    now?: Date;
  } = {},
): ChatMessage[] {
  const mode = opts.mode ?? getSystemDateMode();
  if (mode === 'off') return messages;
  if (mode === 'web_search' && !hasWebSearchInRequest(messages, opts.tools)) return messages;
  if (alreadyHasDateContext(messages)) return messages;
  return [{ role: 'system', content: formatSystemDatePrompt(opts.now) }, ...messages];
}
