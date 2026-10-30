import { describe, expect, it } from 'vitest';
import { getAllProviders } from '../../providers/index.js';
import {
  getProviderMetadata, hasProviderMetadata, listProviderMetadata, modelFreeStatus,
} from '../../providers/metadata.js';

describe('provider metadata', () => {
  it('describes every registered provider', () => {
    const missing = getAllProviders().map(p => p.platform).filter(p => !hasProviderMetadata(p));
    expect(missing).toEqual([]);
  });

  it('claims no independent verification that has not happened', () => {
    for (const meta of listProviderMetadata()) {
      // Nothing has been checked against official docs yet, so nothing may say so.
      expect(meta.officialDocsVerifiedOn, meta.platform).toBeNull();
      expect(meta.confidence, meta.platform).not.toBe('high');
      expect(meta.evidence.kind === 'repo-documented' ? meta.evidence.sources.length : 0, meta.platform).toBeGreaterThanOrEqual(
        meta.evidence.kind === 'repo-documented' ? 1 : 0,
      );
    }
  });

  it('labels where every documentation URL came from', () => {
    for (const meta of listProviderMetadata()) {
      if (meta.docsUrl === null) expect(meta.docsUrlSource, meta.platform).toBeNull();
      else {
        expect(['repo', 'unchecked'], meta.platform).toContain(meta.docsUrlSource);
        expect(meta.docsUrl, meta.platform).toMatch(/^https:\/\//);
      }
    }
  });

  it('matches the registered keyless flag', () => {
    for (const provider of getAllProviders()) {
      const meta = getProviderMetadata(provider.platform);
      if (meta.freeTier === 'operator-managed') continue;
      expect(meta.auth === 'keyless', provider.platform).toBe(provider.keyless);
    }
  });

  it('only uses a free-model rule where some models are free', () => {
    for (const meta of listProviderMetadata()) {
      if (!meta.freeModelRule) continue;
      expect(['free-recurring', 'free-model-subset'], meta.platform).toContain(meta.freeTier);
    }
  });

  it('treats an unknown platform as unknown, not free', () => {
    const meta = getProviderMetadata('not-a-platform');
    expect(meta.freeTier).toBe('unknown');
    expect(meta.confidence).toBe('low');
    expect(modelFreeStatus(meta, 'anything')).toBe('not-free');
  });

  it('keeps entries immutable', () => {
    expect(Object.isFrozen(getProviderMetadata('google'))).toBe(true);
  });

  describe('modelFreeStatus', () => {
    it('keeps Gemini Flash free and Pro-class models out (repo: Pro left the free tier 2026-04-01)', () => {
      const google = getProviderMetadata('google');
      expect(modelFreeStatus(google, 'gemini-3.5-flash')).toBe('free');
      expect(modelFreeStatus(google, 'gemma-4-31b-it')).toBe('free');
      expect(modelFreeStatus(google, 'gemini-2.5-pro')).toBe('not-free');
      expect(modelFreeStatus(google, 'gemini-3.1-pro-preview')).toBe('not-free');
    });

    it('applies suffix, id and pattern rules case-insensitively', () => {
      const openrouter = getProviderMetadata('openrouter');
      expect(modelFreeStatus(openrouter, 'meta-llama/llama-3.3-70b-instruct:free')).toBe('free');
      expect(modelFreeStatus(openrouter, 'anthropic/claude-opus')).toBe('not-free');
      expect(modelFreeStatus(getProviderMetadata('zhipu'), 'GLM-4.7-Flash')).toBe('free');
      expect(modelFreeStatus(getProviderMetadata('zhipu'), 'glm-4.6')).toBe('not-free');
      expect(modelFreeStatus(getProviderMetadata('bazaarlink'), 'auto:free')).toBe('free');
      expect(modelFreeStatus(getProviderMetadata('bazaarlink'), 'gpt-4o')).toBe('not-free');
      expect(modelFreeStatus(getProviderMetadata('qianfan'), 'ernie-speed-128k')).toBe('free');
      expect(modelFreeStatus(getProviderMetadata('qianfan'), 'ernie-4.5-turbo')).toBe('not-free');
    });

    it('returns unknown when some models are free but no rule says which', () => {
      expect(modelFreeStatus(getProviderMetadata('requesty'), 'whatever/model')).toBe('unknown');
    });

    it('never calls trial, credit, promotional, paid or retired access free', () => {
      for (const platform of ['cohere', 'huggingface', 'agnes', 'sail', 'reka', 'sambanova', 'blaze', 'custom']) {
        expect(modelFreeStatus(getProviderMetadata(platform), 'any-model'), platform).toBe('not-free');
      }
    });
  });
});
