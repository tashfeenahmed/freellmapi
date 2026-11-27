import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { initDb, setSetting } from '../../db/index.js';
import {
  SYSTEM_DATE_SETTING,
  type ToolLike,
  alreadyHasDateContext,
  formatSystemDatePrompt,
  getSystemDateMode,
  hasWebSearchInRequest,
  maybeInjectSystemDate,
  setSystemDateMode,
} from '../../lib/system-date.js';

const FIXED_NOW = new Date('2026-11-24T23:45:00.000Z');

describe('system-date injection (#1931)', () => {
  const prevEnv = process.env.FREELLMAPI_INJECT_SYSTEM_DATE;

  beforeEach(() => {
    delete process.env.FREELLMAPI_INJECT_SYSTEM_DATE;
    initDb(':memory:');
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.FREELLMAPI_INJECT_SYSTEM_DATE;
    else process.env.FREELLMAPI_INJECT_SYSTEM_DATE = prevEnv;
  });

  it('defaults to off, falls back to env var, and gives the DB setting precedence', () => {
    expect(getSystemDateMode()).toBe('off');

    process.env.FREELLMAPI_INJECT_SYSTEM_DATE = 'web_search';
    expect(getSystemDateMode()).toBe('web_search');

    process.env.FREELLMAPI_INJECT_SYSTEM_DATE = 'always';
    expect(getSystemDateMode()).toBe('always');

    setSystemDateMode('off');
    expect(getSystemDateMode()).toBe('off');

    setSetting(SYSTEM_DATE_SETTING, 'web_search');
    expect(getSystemDateMode()).toBe('web_search');
  });

  it('formats a date-only UTC system prompt so caches remain valid all day', () => {
    expect(formatSystemDatePrompt(FIXED_NOW)).toBe('Current date: 2026-11-24 (UTC).');
  });

  it('returns the exact original messages array when mode is off', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Latest NVIDIA stock?' }];
    const out = maybeInjectSystemDate(msgs, { mode: 'off', now: FIXED_NOW });
    expect(out).toBe(msgs);
  });

  it('prepends the date without mutating the caller array when mode is always', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Latest NVIDIA stock?' },
    ];
    const snapshot = structuredClone(msgs);
    const out = maybeInjectSystemDate(msgs, { mode: 'always', now: FIXED_NOW });

    expect(msgs).toEqual(snapshot);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: 'system', content: 'Current date: 2026-11-24 (UTC).' });
    expect(out[1]).toEqual(msgs[0]);
  });

  it('in web_search mode injects only when web-search tools or Playground search context are present', () => {
    const plain: ChatMessage[] = [{ role: 'user', content: 'Explain closures.' }];
    const readTool: ToolLike[] = [{ type: 'function', function: { name: 'read_file' } }];
    expect(hasWebSearchInRequest(plain, readTool)).toBe(false);
    expect(maybeInjectSystemDate(plain, { mode: 'web_search', tools: readTool, now: FIXED_NOW })).toBe(plain);

    const searchTool: ToolLike[] = [{ type: 'function', function: { name: 'web_search' } }];
    expect(hasWebSearchInRequest(plain, searchTool)).toBe(true);
    const withTool = maybeInjectSystemDate(plain, { mode: 'web_search', tools: searchTool, now: FIXED_NOW });
    expect(withTool[0]).toEqual({ role: 'system', content: 'Current date: 2026-11-24 (UTC).' });

    const playgroundSearch: ChatMessage[] = [
      { role: 'system', content: 'Web search results for "NVIDIA stock":\n\n[1] Finance (https://example.com)' },
      { role: 'user', content: 'Latest NVIDIA stock?' },
    ];
    expect(hasWebSearchInRequest(playgroundSearch)).toBe(true);
    const withContext = maybeInjectSystemDate(playgroundSearch, { mode: 'web_search', now: FIXED_NOW });
    expect(withContext[0]).toEqual({ role: 'system', content: 'Current date: 2026-11-24 (UTC).' });
  });

  it('skips injection when the caller system prompt already provides a date', () => {
    const claudeStyle: ChatMessage[] = [
      { role: 'system', content: "You are a coding assistant. Today's date is 2026-11-24." },
      { role: 'user', content: 'hi' },
    ];
    const customDate = [
      { role: 'developer', content: 'Current date: 2026-11-24' },
      { role: 'user', content: 'hi' },
    ] as unknown as ChatMessage[];
    expect(alreadyHasDateContext(claudeStyle)).toBe(true);
    expect(alreadyHasDateContext(customDate)).toBe(true);
    expect(maybeInjectSystemDate(claudeStyle, { mode: 'always', now: FIXED_NOW })).toBe(claudeStyle);
    expect(maybeInjectSystemDate(customDate, { mode: 'always', now: FIXED_NOW })).toBe(customDate);
  });
});
