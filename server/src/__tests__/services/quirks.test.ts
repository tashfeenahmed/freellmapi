import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { resolveQuirksByModel, quirkKey, listQuirkDefinitions } from '../../services/quirks.js';

// The quirks layer is the catalog product's data integrity: one quirk is
// applied to many models by selector parameters (migrateQuirksV1). These lock
// the platform / glob / global selectors and the resolver that the catalog
// export depends on.
describe('quirks resolution (migrateQuirksV1)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function slugsFor(platform: string, modelId: string): string[] {
    return (resolveQuirksByModel().get(quirkKey(platform, modelId)) ?? []).map((q) => q.slug);
  }

  it('applies a platform-level quirk to every model on that platform', () => {
    const nvidiaModels = getDb()
      .prepare("SELECT model_id FROM models WHERE platform = 'nvidia'")
      .all() as { model_id: string }[];
    expect(nvidiaModels.length).toBeGreaterThan(0);
    for (const m of nvidiaModels) {
      expect(slugsFor('nvidia', m.model_id)).toContain('nvidia-rate-limited');
    }
  });

  it('applies a glob quirk only to matching model ids', () => {
    // or-ultra-hangs targets openrouter '*nemotron-3-ultra*'
    const ultra = getDb()
      .prepare("SELECT model_id FROM models WHERE platform = 'openrouter' AND model_id GLOB '*nemotron-3-ultra*'")
      .get() as { model_id: string } | undefined;
    if (ultra) expect(slugsFor('openrouter', ultra.model_id)).toContain('or-ultra-hangs');

    // A non-matching openrouter model must NOT pick it up.
    const other = getDb()
      .prepare("SELECT model_id FROM models WHERE platform = 'openrouter' AND model_id NOT GLOB '*nemotron-3-ultra*'")
      .get() as { model_id: string } | undefined;
    if (other) expect(slugsFor('openrouter', other.model_id)).not.toContain('or-ultra-hangs');
  });

  it('does not leak a platform quirk onto other platforms', () => {
    const google = getDb()
      .prepare("SELECT model_id FROM models WHERE platform = 'google'")
      .get() as { model_id: string } | undefined;
    if (google) expect(slugsFor('google', google.model_id)).not.toContain('cloudflare-key-format');
  });

  it('lists quirk definitions with their selector parameters', () => {
    const defs = listQuirkDefinitions();
    const keyless = defs.find((d) => d.slug === 'keyless-anonymous');
    expect(keyless).toBeDefined();
    // keyless-anonymous targets the four keyless platforms.
    const platforms = keyless!.targets.map((t) => t.platform).sort();
    expect(platforms).toEqual(['kilo', 'llm7', 'ovh', 'pollinations']);
  });

  it('resolves stably and dedups overlapping selectors', () => {
    // A model matched by two of a quirk's selectors must list it once (DISTINCT).
    const a = resolveQuirksByModel();
    const b = resolveQuirksByModel();
    expect(a.size).toBe(b.size);
    for (const [key, quirks] of a) {
      const slugs = quirks.map((q) => q.slug);
      expect(new Set(slugs).size).toBe(slugs.length); // no duplicates
      expect(b.get(key)!.map((q) => q.slug)).toEqual(slugs); // stable
    }
  });
});
