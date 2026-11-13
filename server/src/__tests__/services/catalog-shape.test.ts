import { describe, it, expect } from 'vitest';
import { catalogShapeProblems } from '../../services/catalog-sync.js';

// #1566: a rejected catalog payload used to fail as one opaque line
// ("catalog payload has unexpected shape") with no indication of WHICH
// section broke. catalogShapeProblems names the path. These tests lock the
// diagnostics AND — via the differential pass below — that the new check
// accepts/rejects exactly what the original &&-chain did.

// The original validator, verbatim from before #1566, kept here ONLY as the
// differential oracle for the equivalence test at the bottom.
function oldIsCatalog(value: unknown): boolean {
  const c = value as any;
  return (
    !!c &&
    typeof c.version === 'string' &&
    (c.tier === 'live' || c.tier === 'monthly') &&
    Array.isArray(c.models) &&
    Array.isArray(c.quirks) &&
    (c.embeddings === undefined ||
      (Array.isArray(c.embeddings) &&
        c.embeddings.every(
          (m: any) =>
            typeof m?.family === 'string' &&
            typeof m?.platform === 'string' &&
            typeof m?.modelId === 'string' &&
            typeof m?.displayName === 'string' &&
            typeof m?.dimensions === 'number' &&
            typeof m?.priority === 'number' &&
            typeof m?.enabled === 'boolean',
        ))) &&
    (c.transcriptionModels === undefined ||
      (Array.isArray(c.transcriptionModels) &&
        c.transcriptionModels.every(
          (m: any) =>
            typeof m?.platform === 'string' &&
            typeof m?.modelId === 'string' &&
            typeof m?.displayName === 'string' &&
            typeof m?.priority === 'number' &&
            typeof m?.enabled === 'boolean' &&
            (m.subtitleFormats === undefined ||
              (Array.isArray(m.subtitleFormats) && m.subtitleFormats.every((f: string) => typeof f === 'string'))) &&
            (m.maxBytes === undefined || m.maxBytes === null || typeof m.maxBytes === 'number') &&
            (m.requestStyle === undefined || m.requestStyle === null || typeof m.requestStyle === 'string'),
        ))) &&
    (c.videoModels === undefined ||
      (Array.isArray(c.videoModels) &&
        c.videoModels.every(
          (m: any) =>
            typeof m?.platform === 'string' &&
            typeof m?.modelId === 'string' &&
            typeof m?.displayName === 'string' &&
            typeof m?.priority === 'number' &&
            typeof m?.enabled === 'boolean' &&
            (m.quotaLabel === undefined || typeof m.quotaLabel === 'string') &&
            (m.providerModelId === undefined || typeof m.providerModelId === 'string'),
        ))) &&
    c.models.every(
      (m: any) =>
        typeof m?.platform === 'string' &&
        typeof m?.modelId === 'string' &&
        typeof m?.displayName === 'string' &&
        typeof m?.enabled === 'boolean' &&
        (m.requestStyle === undefined || m.requestStyle === null || typeof m.requestStyle === 'string') &&
        !!m?.limits &&
        typeof m.limits === 'object',
    ) &&
    (c.searchEngines === undefined ||
      (Array.isArray(c.searchEngines) &&
        c.searchEngines.every(
          (e: any) =>
            typeof e?.platform === 'string' &&
            typeof e?.engineId === 'string' &&
            typeof e?.displayName === 'string' &&
            typeof e?.priority === 'number' &&
            typeof e?.enabled === 'boolean' &&
            (e.quotaLabel === undefined || typeof e.quotaLabel === 'string') &&
            (e.creditsPerQuery === undefined || e.creditsPerQuery === null || typeof e.creditsPerQuery === 'number') &&
            (e.features === undefined || (typeof e.features === 'object' && e.features !== null)) &&
            (e.premiumSince === undefined || typeof e.premiumSince === 'string'),
        ))) &&
    (c.decisionModels === undefined ||
      (Array.isArray(c.decisionModels) &&
        c.decisionModels.every(
          (m: any) =>
            typeof m?.platform === 'string' &&
            typeof m?.modelId === 'string' &&
            typeof m?.displayName === 'string' &&
            typeof m?.priority === 'number' &&
            typeof m?.enabled === 'boolean' &&
            (m.quotaLabel === undefined || typeof m.quotaLabel === 'string') &&
            (m.contextWindow === undefined || typeof m.contextWindow === 'number') &&
            (m.premiumSince === undefined || typeof m.premiumSince === 'string'),
        ))) &&
    (c.managedPlatforms === undefined ||
      (Array.isArray(c.managedPlatforms) && c.managedPlatforms.every((p: string) => typeof p === 'string'))) &&
    c.quirks.every((q: any) => typeof q?.slug === 'string' && Array.isArray(q?.targets))
  );
}

const model = { platform: 'groq', modelId: 'm', displayName: 'M', enabled: true, limits: {} };
const quirk = { slug: 'q', targets: [] };
function base(extra: Record<string, unknown> = {}) {
  return { version: '2099.01.01', generatedAt: 'x', tier: 'live', models: [model], quirks: [quirk], ...extra };
}

describe('catalogShapeProblems (#1566 diagnostics)', () => {
  it('accepts a minimal valid catalog', () => {
    expect(catalogShapeProblems(base())).toEqual([]);
  });

  it('names the failing top-level field', () => {
    expect(catalogShapeProblems(base({ tier: 'weekly' })).join(' ')).toContain('tier');
    expect(catalogShapeProblems(base({ version: 5 })).join(' ')).toContain('version');
    expect(catalogShapeProblems(base({ models: 'nope' })).join(' ')).toContain('models is not an array');
  });

  it('points at the exact array index that broke', () => {
    const bad = base({
      embeddings: [
        { family: 'f', platform: 'p', modelId: 'm', displayName: 'D', dimensions: 8, priority: 1, enabled: true },
        { family: 'f', platform: 'p', modelId: 'm', displayName: 'D', dimensions: '8', priority: 1, enabled: true },
      ],
    });
    const problems = catalogShapeProblems(bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe('embeddings[1] dimensions is not a number');
  });

  it('caps the report so a garbage payload cannot flood the log', () => {
    const bad = base({
      models: Array.from({ length: 50 }, (_, i) => ({ ...model, enabled: i % 2 === 0 ? true : 'yes' })),
    });
    expect(catalogShapeProblems(bad).length).toBeLessThanOrEqual(8);
    expect(catalogShapeProblems(bad).length).toBeGreaterThan(0);
  });

  it('rejects null for optional fields the old check rejected (quotaLabel, premiumSince, contextWindow)', () => {
    // These are `=== undefined || typeof === 'string'` checks in the old
    // validator: an explicit null FAILS. The new one must not quietly loosen
    // the contract.
    const search = { platform: 'p', engineId: 'e', displayName: 'D', priority: 1, enabled: true };
    expect(catalogShapeProblems(base({ searchEngines: [{ ...search, quotaLabel: null }] })).length).toBe(1);
    expect(catalogShapeProblems(base({ searchEngines: [{ ...search, premiumSince: null }] })).length).toBe(1);
    const decision = { platform: 'p', modelId: 'm', displayName: 'D', priority: 1, enabled: true };
    expect(catalogShapeProblems(base({ decisionModels: [{ ...decision, contextWindow: null }] })).length).toBe(1);
  });

  it('accepts null where the old check allowed null (maxBytes, requestStyle, creditsPerQuery)', () => {
    expect(catalogShapeProblems(base({
      transcriptionModels: [{ platform: 'p', modelId: 'm', displayName: 'D', priority: 1, enabled: true, maxBytes: null, requestStyle: null }],
    }))).toEqual([]);
    expect(catalogShapeProblems(base({
      searchEngines: [{ platform: 'p', engineId: 'e', displayName: 'D', priority: 1, enabled: true, creditsPerQuery: null }],
    }))).toEqual([]);
    expect(catalogShapeProblems(base({ models: [{ ...model, requestStyle: null }] }))).toEqual([]);
  });

  it('rejects non-object payloads', () => {
    expect(catalogShapeProblems(null).length).toBe(1);
    expect(catalogShapeProblems('html error page').length).toBe(1);
    // [] passes `typeof === 'object'` but fails the required-field checks —
    // same verdict as the old chain (its version check rejected it).
    expect(catalogShapeProblems([]).length).toBeGreaterThan(0);
  });
});

describe('catalogShapeProblems ≡ old isCatalog (differential)', () => {
  // Every mutation below must produce EXACTLY the same accept/reject verdict
  // from the new implementation as the original &&-chain produced.
  const embeddingsOk = [{ family: 'f', platform: 'p', modelId: 'm', displayName: 'D', dimensions: 8, priority: 1, enabled: true }];
  const sttOk = [{ platform: 'p', modelId: 'm', displayName: 'D', priority: 1, enabled: true }];
  const videoOk = [{ platform: 'p', modelId: 'm', displayName: 'D', priority: 1, enabled: true }];
  const searchOk = [{ platform: 'p', engineId: 'e', displayName: 'D', priority: 1, enabled: true }];
  const decisionOk = [{ platform: 'p', modelId: 'm', displayName: 'D', priority: 1, enabled: true }];

  const cases: Array<[string, unknown]> = [
    ['minimal', base()],
    ['full valid', base({ embeddings: embeddingsOk, transcriptionModels: sttOk, videoModels: videoOk, searchEngines: searchOk, decisionModels: decisionOk, managedPlatforms: ['groq'] })],
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['array', []],
    ['string', 'oops'],
    ['tier wrong', base({ tier: 'weekly' })],
    ['version missing', base({ version: undefined })],
    ['models null entry', base({ models: [null] })],
    ['models missing limits', base({ models: [{ ...model, limits: undefined }] })],
    ['models limits string', base({ models: [{ ...model, limits: 'x' }] })],
    ['models requestStyle null', base({ models: [{ ...model, requestStyle: null }] })],
    ['models requestStyle bad', base({ models: [{ ...model, requestStyle: 3 }] })],
    ['quirks bad', base({ quirks: [{ slug: 'a' }] })],
    ['embeddings not array', base({ embeddings: {} })],
    ['embeddings dimensions string', base({ embeddings: [{ ...embeddingsOk[0], dimensions: '8' }] })],
    ['embeddings enabled missing', base({ embeddings: [{ family: 'f', platform: 'p', modelId: 'm', displayName: 'D', dimensions: 1, priority: 1 }] })],
    ['stt subtitleFormats bad', base({ transcriptionModels: [{ ...sttOk[0], subtitleFormats: [1] }] })],
    ['stt maxBytes null', base({ transcriptionModels: [{ ...sttOk[0], maxBytes: null }] })],
    ['stt maxBytes string', base({ transcriptionModels: [{ ...sttOk[0], maxBytes: '9' }] })],
    ['stt requestStyle null', base({ transcriptionModels: [{ ...sttOk[0], requestStyle: null }] })],
    ['video quotaLabel null', base({ videoModels: [{ ...videoOk[0], quotaLabel: null }] })],
    ['video providerModelId ok', base({ videoModels: [{ ...videoOk[0], providerModelId: 'x' }] })],
    ['search creditsPerQuery null', base({ searchEngines: [{ ...searchOk[0], creditsPerQuery: null }] })],
    ['search creditsPerQuery string', base({ searchEngines: [{ ...searchOk[0], creditsPerQuery: '1' }] })],
    ['search quotaLabel null', base({ searchEngines: [{ ...searchOk[0], quotaLabel: null }] })],
    ['search features null', base({ searchEngines: [{ ...searchOk[0], features: null }] })],
    ['search features obj', base({ searchEngines: [{ ...searchOk[0], features: {} }] })],
    ['search premiumSince null', base({ searchEngines: [{ ...searchOk[0], premiumSince: null }] })],
    ['decision contextWindow null', base({ decisionModels: [{ ...decisionOk[0], contextWindow: null }] })],
    ['decision quotaLabel null', base({ decisionModels: [{ ...decisionOk[0], quotaLabel: null }] })],
    ['decision premiumSince ok', base({ decisionModels: [{ ...decisionOk[0], premiumSince: '2026-01-01' }] })],
    ['managedPlatforms not array', base({ managedPlatforms: 'groq' })],
    ['managedPlatforms non-string', base({ managedPlatforms: [1] })],
    ['embeddings empty array', base({ embeddings: [] })],
    ['models empty array', base({ models: [] })],
  ];

  for (const [name, payload] of cases) {
    it(`agrees on: ${name}`, () => {
      const oldVerdict = oldIsCatalog(payload);
      const newVerdict = catalogShapeProblems(payload).length === 0;
      expect(newVerdict).toBe(oldVerdict);
    });
  }
});
