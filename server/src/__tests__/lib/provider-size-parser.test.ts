import { describe, expect, it } from 'vitest';
import { parseProviderReportedSize } from '../../lib/provider-size-parser.js';

// Bodies were captured verbatim from the live requests table (provider + status
// = error, last 30 days) and trimmed only to fit. Each test pins one real
// observed error message shape so a provider changing its wording trips the
// test and forces a parser update.
describe('parseProviderReportedSize', () => {
  describe('groq', () => {
    it('extracts Requested N from a TPM 413', () => {
      const msg = 'Groq API error 413: Request too large for model `openai/gpt-oss-120b` in organization `org_01kptjck7bejta1btzc11cccy2` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 36532, please reduce your message size and try again.';
      expect(parseProviderReportedSize('groq', msg)).toBe(36532);
    });

    it('extracts Requested N from llama-3.1-8b-instant 413', () => {
      const msg = 'Groq API error 413: Request too large for model `llama-3.1-8b-instant` in organization `org_01kptjck7bejta1btzc11cccy2` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Requested 36783, please reduce your message size and try again.';
      expect(parseProviderReportedSize('groq', msg)).toBe(36783);
    });

    it('returns null for the bare "Request Entity Too Large" body', () => {
      // This shape appears 627 times in 30d but carries no number. Returning
      // a number here would falsely report a request size.
      expect(parseProviderReportedSize('groq', 'Groq API error 413: Request Entity Too Large')).toBeNull();
    });

    it('handles thousand-separator commas', () => {
      const msg = 'Groq API error 413: ... Limit 8000, Requested 36,532, please reduce ...';
      expect(parseProviderReportedSize('groq', msg)).toBe(36532);
    });
  });

  describe('openrouter', () => {
    it('extracts the total from "requested about N tokens (...)"', () => {
      const msg = 'OpenRouter API error 400: This endpoint\'s maximum context length is 65536 tokens. However, you requested about 68982 tokens (4982 of text input, 64000 in the output). Please reduce the length of either one, or use the context-compression.';
      expect(parseProviderReportedSize('openrouter', msg)).toBe(68982);
    });

    it('handles variation in thousand separators and whitespace', () => {
      const msg = 'OpenRouter API error 400: requested about 68,847 tokens (4847 of text input, 64000 in the output).';
      expect(parseProviderReportedSize('openrouter', msg)).toBe(68847);
    });

    it('returns null on a non-size error', () => {
      expect(parseProviderReportedSize('openrouter', 'OpenRouter API error 429: Provider returned error')).toBeNull();
    });
  });

  describe('cloudflare', () => {
    it('prefers the input-only number from a 400 context-length body', () => {
      const msg = 'Cloudflare API error 400: AiError: AiError: {"error":{"message":"This model\'s maximum context length is 24000 tokens. However, you requested 256 output tokens and your prompt contains at least 23745 input tokens, for a total of at least 24001 tokens."}}';
      expect(parseProviderReportedSize('cloudflare', msg)).toBe(23745);
    });

    it('falls back to the combined total from a 413 "tokens (N) exceeded" body', () => {
      const msg = 'Cloudflare API error 413: AiError: Ai: The estimated number of input and maximum output tokens (24092) exceeded this model context window limit (24000). (1ffb6b51-7168-4e29-a4ab-378d87917a79)';
      expect(parseProviderReportedSize('cloudflare', msg)).toBe(24092);
    });

    it('returns null on a non-size error', () => {
      expect(parseProviderReportedSize('cloudflare', 'Cloudflare API error 429: AiError: you have used up your daily free allocation')).toBeNull();
    });
  });

  describe('github', () => {
    it('returns null even though the body is parseable (limit only, not request size)', () => {
      // "Max size: 8000 tokens" is the LIMIT ceiling. Returning 8000 would
      // cause every subsequent model with TPM < 8000 to be skipped for the
      // rest of the request — wildly wrong. The parser must refuse.
      const msg = 'GitHub Models API error 413: Request body too large for gpt-4.1 model. Max size: 8000 tokens.';
      expect(parseProviderReportedSize('github', msg)).toBeNull();
    });
  });

  describe('providers without a parser', () => {
    it('returns null for ollama, nvidia, anthropic, google, opencode, llm7, cerebras, custom', () => {
      for (const p of ['ollama', 'nvidia', 'anthropic', 'google', 'opencode', 'llm7', 'cerebras', 'custom']) {
        expect(parseProviderReportedSize(p, 'some error containing 12345 tokens')).toBeNull();
      }
    });
  });

  describe('edge cases', () => {
    it('returns null for empty / nullish message', () => {
      expect(parseProviderReportedSize('groq', undefined)).toBeNull();
      expect(parseProviderReportedSize('groq', null)).toBeNull();
      expect(parseProviderReportedSize('groq', '')).toBeNull();
    });

    it('returns null when the number is missing or malformed', () => {
      expect(parseProviderReportedSize('groq', 'Limit zero, Requested none, please reduce')).toBeNull();
      expect(parseProviderReportedSize('openrouter', 'requested about zero tokens')).toBeNull();
    });

    it('ignores zero or negative numbers', () => {
      // Defensive — shouldn't happen with real providers, but a stray "0" in
      // an error template would otherwise set observedRequestTokens=0 and
      // silently disable the gate for the rest of the request.
      const msg = 'Groq API error 413: ... Limit 8000, Requested 0, ...';
      expect(parseProviderReportedSize('groq', msg)).toBeNull();
    });
  });
});