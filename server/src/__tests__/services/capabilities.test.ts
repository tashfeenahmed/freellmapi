import { describe, it, expect } from 'vitest';
import { findModel } from '../../services/capabilities.js';

type MockModel = { slug: string; context_length: number; supports_reasoning: boolean; input_modalities: string[] };

function mock(slug: string, ctx = 100_000, reasoning = false, modalities: string[] = ['text']): MockModel {
  return { slug, context_length: ctx, supports_reasoning: reasoning, input_modalities: modalities };
}

function extractVersion(slug: string): number {
  const match = slug.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

/** Build all three lookups like syncFromOpenRouterFrontend does. */
function buildMaps(models: MockModel[]) {
  const modelsBySlug = new Map<string, MockModel>();
  const modelsByName = new Map<string, MockModel>();
  const modelsByBaseName = new Map<string, MockModel>();
  for (const m of models) {
    modelsBySlug.set(m.slug.toLowerCase(), m);
    const nameMatch = m.slug.match(/\/([^/]+)$/);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const existing = modelsByName.get(name);
    if (!existing || extractVersion(m.slug) > extractVersion(existing.slug)) {
      modelsByName.set(name, m);
    }
    const baseName = name.replace(/-\d+$/, '');
    if (baseName !== name) {
      const existingBase = modelsByBaseName.get(baseName);
      if (!existingBase || extractVersion(m.slug) > extractVersion(existingBase.slug)) {
        modelsByBaseName.set(baseName, m);
      }
    }
  }
  return { modelsBySlug, modelsByName, modelsByBaseName };
}

describe('findModel matching heuristics', () => {
  const { modelsBySlug, modelsByName, modelsByBaseName } = buildMaps([
    mock('google/gemini-2.5-flash', 1_048_576, true, ['text', 'image']),
    mock('meta-llama/llama-4-scout-17b-16e-instruct', 131_072, false, ['text', 'image']),
    mock('openai/gpt-oss-120b', 131_072, false, ['text']),
    mock('qwen/qwen3-coder', 262_144, false, ['text']),
    mock('minimax/minimax-m3', 1_048_576, true, ['text', 'image', 'video']),
    mock('llama-4-scout', 131_072, false, ['text']),
    mock('mistralai/devstral-2512', 262_144, false, ['text']),
    mock('mistralai/devstral-2505', 131_072, false, ['text']),
    mock('mistralai/codestral-2508', 256_000, false, ['text']),
    mock('deepseek/deepseek-v4-flash', 1_048_576, false, ['text']),
  ]);

  it('matches openrouter :free models by stripping :free suffix', () => {
    const m = findModel('openrouter', 'google/gemini-2.5-flash:free', modelsBySlug, modelsByName, modelsByBaseName);
    expect(m).not.toBeNull();
    expect(m!.context_length).toBe(1_048_576);
  });

  it('returns null for unknown models', () => {
    expect(findModel('openrouter', 'unknown/model:free', modelsBySlug, modelsByName, modelsByBaseName)).toBeNull();
  });

  it('matches by reverse substring (strategy 5)', () => {
    const m = findModel('cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', modelsBySlug, modelsByName, modelsByBaseName);
    expect(m).not.toBeNull();
    expect(m!.slug).toMatch(/llama-4-scout/);
  });

  it('skips trivial slug matches (length < 8)', () => {
    const { modelsBySlug: s, modelsByName: n, modelsByBaseName: b } = buildMaps([mock('m3', 100_000, true)]);
    expect(findModel('opencode', 'big-pickle', s, n, b)).toBeNull();
  });

  it('strips -free suffix for non-OR platforms', () => {
    const m = findModel('opencode', 'minimax-m3-free', modelsBySlug, modelsByName, modelsByBaseName);
    expect(m).not.toBeNull();
    expect(m!.context_length).toBe(1_048_576);
  });

  it('strips -latest and matches highest version via base-name lookup (strategy 3)', () => {
    const m = findModel('mistral', 'devstral-latest', modelsBySlug, modelsByName, modelsByBaseName);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe('mistralai/devstral-2512');
    expect(m!.context_length).toBe(262_144);
  });

  it('matches codestral-latest via base-name lookup', () => {
    const m = findModel('mistral', 'codestral-latest', modelsBySlug, modelsByName, modelsByBaseName);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe('mistralai/codestral-2508');
    expect(m!.context_length).toBe(256_000);
  });

  it('matches model name regardless of provider prefix (strategy 4/7)', () => {
    const m = findModel('opencode', 'deepseek-v4-flash', modelsBySlug, modelsByName, modelsByBaseName);
    expect(m).not.toBeNull();
    expect(m!.context_length).toBe(1_048_576);
  });

  // Strategy 8: reverse name substring — our name contains OR name
  it('matches Meta-Llama-3.3-70B-Instruct via reverse name (strategy 8)', () => {
    // Our name 'meta-llama-3.3-70b-instruct' contains OR name 'llama-3.3-70b-instruct'
    // from slug 'meta-llama/llama-3.3-70b-instruct'
    const or = mock('meta-llama/llama-3.3-70b-instruct', 131_072);
    const { modelsBySlug: s, modelsByName: n, modelsByBaseName: b } = buildMaps([or]);
    const m = findModel('sambanova', 'Meta-Llama-3.3-70B-Instruct', s, n, b);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe('meta-llama/llama-3.3-70b-instruct');
  });

  it('matches Llama-4-Maverick-17B-128E-Instruct via reverse name (strategy 8)', () => {
    // Our name 'llama-4-maverick-17b-128e-instruct' contains OR name 'llama-4-maverick'
    const or = mock('meta-llama/llama-4-maverick', 1_048_576);
    const { modelsBySlug: s, modelsByName: n, modelsByBaseName: b } = buildMaps([or]);
    const m = findModel('sambanova', 'Llama-4-Maverick-17B-128E-Instruct', s, n, b);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe('meta-llama/llama-4-maverick');
  });

  it('matches zai-glm-4.7 via reverse name (strategy 8)', () => {
    // Our name 'zai-glm-4.7' contains OR name 'glm-4.7'
    const or = mock('z-ai/glm-4.7', 202_752);
    const { modelsBySlug: s, modelsByName: n, modelsByBaseName: b } = buildMaps([or]);
    const m = findModel('cerebras', 'zai-glm-4.7', s, n, b);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe('z-ai/glm-4.7');
  });

  it('matches glm-4.5-flash via reverse name (strategy 8)', () => {
    // Our name 'glm-4.5-flash' contains OR name 'glm-4.5'
    const or = mock('z-ai/glm-4.5', 131_072);
    const { modelsBySlug: s, modelsByName: n, modelsByBaseName: b } = buildMaps([or]);
    const m = findModel('zhipu', 'glm-4.5-flash', s, n, b);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe('z-ai/glm-4.5');
  });

  it('matches llama-3.3-70b-instruct-fp8-fast via reverse name (strategy 8)', () => {
    // Our name 'llama-3.3-70b-instruct-fp8-fast' contains OR name 'llama-3.3-70b-instruct'
    const or = mock('meta-llama/llama-3.3-70b-instruct', 131_072);
    const { modelsBySlug: s, modelsByName: n, modelsByBaseName: b } = buildMaps([or]);
    const m = findModel('cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', s, n, b);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe('meta-llama/llama-3.3-70b-instruct');
  });

  it('matches command-a-03-2025 via reverse name (strategy 8)', () => {
    // Our name 'command-a-03-2025' contains OR name 'command-a'
    const or = mock('cohere/command-a', 256_000);
    const { modelsBySlug: s, modelsByName: n, modelsByBaseName: b } = buildMaps([or]);
    const m = findModel('cohere', 'command-a-03-2025', s, n, b);
    expect(m).not.toBeNull();
    expect(m!.slug).toBe('cohere/command-a');
  });

  it('returns null when OR name is too short to match (< 6 chars)', () => {
    // OR name 'llama' is only 5 chars, should not match
    const or = mock('meta-llama/llama', 131_072);
    const { modelsBySlug: s, modelsByName: n, modelsByBaseName: b } = buildMaps([or]);
    const m = findModel('sambanova', 'Meta-Llama-3.3-70B-Instruct', s, n, b);
    expect(m).toBeNull();
  });
});
