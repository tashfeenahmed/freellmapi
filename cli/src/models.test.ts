import { describe, expect, it } from 'vitest';
import { UnknownModelError, chosenContextWindow, contextWindowOf, defaultModelId, parseContextWindow, resolveLaunchModel } from './models.js';
import type { CatalogModel } from './types.js';

// The distinction this module exists for: the CLI's catalog() fetches
// `?available=true`, so absence from that roster means EITHER "no such model"
// OR "exists, out of quota right now". Only the unfiltered roster separates
// them, and conflating them reports a healthy pinned model as a typo the
// moment its provider rate-limits.

const AVAILABLE: CatalogModel[] = [
  { id: 'auto' },
  { id: 'fast-coder', available: true, context_window: 131072 },
];

const FULL: CatalogModel[] = [
  ...AVAILABLE,
  { id: 'benched-model', available: false, context_window: 32768 },
  { id: 'no-window-model', available: true },
];

describe('resolveLaunchModel', () => {
  it('accepts a model that is registered but not currently servable', () => {
    const resolved = resolveLaunchModel('benched-model', AVAILABLE, FULL);
    expect(resolved.id).toBe('benched-model');
    expect(resolved.unavailable).toBe(true);
    expect(resolved.contextWindow).toBe(32768);
  });

  it('rejects a model that is in neither roster', () => {
    expect(() => resolveLaunchModel('no-such-model', AVAILABLE, FULL))
      .toThrow(UnknownModelError);
  });

  it('suggests near-matches on an unknown id rather than only refusing', () => {
    expect(() => resolveLaunchModel('coder', AVAILABLE, FULL))
      .toThrow(/fast-coder/);
  });

  it('reports an available model as available', () => {
    expect(resolveLaunchModel('fast-coder', AVAILABLE, FULL))
      .toMatchObject({ id: 'fast-coder', unavailable: false, contextWindow: 131072 });
  });

  it('leaves the context window undefined when the catalog publishes none', () => {
    // Not 128000. An unpublished window is a different fact from a known one,
    // and inventing a number is how the launcher pinned a wrong compaction
    // threshold for every model whose provider states no window.
    expect(resolveLaunchModel('no-window-model', AVAILABLE, FULL).contextWindow)
      .toBeUndefined();
  });

  it('serves `auto` even though the router never lists it as a catalog row', () => {
    expect(resolveLaunchModel('auto', [], [])).toMatchObject({ id: 'auto', unavailable: false });
  });

  it('falls back to the filtered roster when the unfiltered one is unavailable', () => {
    // Degraded mode: an older gateway ignoring ?available=true, or a failed
    // second fetch. A known-good id must still resolve.
    expect(resolveLaunchModel('fast-coder', AVAILABLE).id).toBe('fast-coder');
  });
});

describe('defaultModelId', () => {
  it('prefers a concrete servable model over auto, so the session names its model', () => {
    expect(defaultModelId(AVAILABLE)).toBe('fast-coder');
  });

  it('falls back to auto when nothing concrete is servable', () => {
    expect(defaultModelId([{ id: 'auto' }, { id: 'x', available: false }])).toBe('auto');
  });
});

describe('contextWindowOf', () => {
  it('accepts either catalog spelling and undefined for neither', () => {
    expect(contextWindowOf({ id: 'a', context_window: 1000 })).toBe(1000);
    expect(contextWindowOf({ id: 'b', context_length: 2000 })).toBe(2000);
    expect(contextWindowOf({ id: 'c' })).toBeUndefined();
    expect(contextWindowOf({ id: 'd', context_window: null })).toBeUndefined();
  });
});

// #2122, #2087: `--context-window` for Claude Code.
describe('chosenContextWindow / parseContextWindow', () => {
  const auto: CatalogModel = { id: 'auto', context_window: 104_857, max_context_window: 838_860 };

  it('defaults to the advertised window, not the largest one', () => {
    expect(chosenContextWindow(auto)).toBe(104_857);
  });

  it('uses max_context_window for max, and the window itself when there is none', () => {
    expect(chosenContextWindow(auto, 'max')).toBe(838_860);
    expect(chosenContextWindow({ id: 'fast-coder', context_window: 131_072 }, 'max')).toBe(131_072);
  });

  it('takes an explicit token count as given', () => {
    expect(chosenContextWindow(auto, 200_000)).toBe(200_000);
  });

  it('parses max, plain counts and k/m suffixes, and rejects the rest', () => {
    expect(parseContextWindow('max')).toBe('max');
    expect(parseContextWindow('MAX')).toBe('max');
    expect(parseContextWindow('200000')).toBe(200_000);
    expect(parseContextWindow('200k')).toBe(200_000);
    expect(parseContextWindow('1m')).toBe(1_000_000);
    expect(() => parseContextWindow('0')).toThrow(/--context-window/);
    expect(() => parseContextWindow('big')).toThrow(/--context-window/);
  });

  it('resolveLaunchModel applies the choice', () => {
    expect(resolveLaunchModel('auto', [auto], [auto], 'max').contextWindow).toBe(838_860);
    expect(resolveLaunchModel('auto', [auto], [auto]).contextWindow).toBe(104_857);
  });
});
