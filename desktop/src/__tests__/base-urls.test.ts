import { describe, it, expect } from 'vitest';
import { gatewayBaseUrl, parseBaseUrlKind } from '../base-urls.js';
import { NATIVE_LOCALES, nativeStrings } from '../i18n.js';

describe('tray base URLs (#1956)', () => {
  it('gives OpenAI-style clients the /v1 base', () => {
    expect(gatewayBaseUrl(31415, 'openai')).toBe('http://127.0.0.1:31415/v1');
  });

  it('gives Claude / Anthropic clients the bare origin, never /v1', () => {
    // Claude Desktop appends /v1/models itself; a /v1 base produced /v1/v1/models.
    const url = gatewayBaseUrl(31415, 'anthropic');
    expect(url).toBe('http://127.0.0.1:31415');
    expect(url).not.toMatch(/\/v1$/);
  });

  it('treats unknown IPC input as the OpenAI URL', () => {
    expect(parseBaseUrlKind('anthropic')).toBe('anthropic');
    expect(parseBaseUrlKind('openai')).toBe('openai');
    expect(parseBaseUrlKind(undefined)).toBe('openai');
    expect(parseBaseUrlKind('../../etc')).toBe('openai');
  });

  it('labels both copy buttons and their hints in every native locale', () => {
    for (const locale of NATIVE_LOCALES) {
      const s = nativeStrings(locale);
      for (const key of ['copyOpenAiUrl', 'copyClaudeUrl', 'openAiUrlHint', 'claudeUrlHint']) {
        expect(s[key], `${locale}.${key}`).toBeTruthy();
      }
      expect(s.copyClaudeUrl, locale).toContain('Claude');
      expect(s.claudeUrlHint, locale).toContain('/v1');
    }
  });
});
