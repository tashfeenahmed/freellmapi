// #1870: no-key providers are on by default for new installs, limited to what
// the install's catalog tier lists (free installs only see rows once they are
// 30 days old; Premium sees the live catalog), and never re-added once removed.
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, getSetting, setSetting } from '../../db/index.js';
import {
  applyKeylessDefaults,
  availableKeylessProviders,
  dismissAvailableKeylessProviders,
  enableAvailableKeylessProviders,
  keylessPlatformsInCatalog,
} from '../../services/keyless-defaults.js';

// What the free (monthly) catalog lists today: the decision-only HAL-X / AI
// SENSE rows and Keenable are still inside their 30-day Premium window.
const FREE_CATALOG = {
  models: [
    { platform: 'kilo', enabled: true },
    { platform: 'ovh', enabled: true },
    { platform: 'aihorde', enabled: true },
    { platform: 'groq', enabled: true },
  ],
  embeddings: [{ platform: 'ovh', enabled: true }],
  searchEngines: [{ platform: 'parallel', enabled: true }],
  decisionModels: [],
};

// Premium gets the live catalog, new providers included.
const PREMIUM_CATALOG = {
  ...FREE_CATALOG,
  searchEngines: [{ platform: 'parallel', enabled: true }, { platform: 'keenable', enabled: true }],
  decisionModels: [{ platform: 'halx', enabled: true }, { platform: 'aisense', enabled: true }],
};

const platforms = () => (getDb().prepare('SELECT platform FROM api_keys ORDER BY platform').all() as { platform: string }[]).map(r => r.platform);

function applyCatalogJson(catalog: unknown) {
  setSetting('catalog_applied_json', JSON.stringify(catalog));
}

describe('no-key providers by default (#1870)', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('marks a database created from scratch as a new install', () => {
    expect(getSetting('keyless_defaults')).toBe('pending');
  });

  it('makes classifier.dev eligible for keyless setup only when its decision row is enabled in this tier', () => {
    expect(keylessPlatformsInCatalog(FREE_CATALOG)).not.toContain('classifierdev');
    const catalog = (enabled: boolean) => ({ ...FREE_CATALOG, decisionModels: [{ platform: 'classifierdev', enabled }] });
    expect(keylessPlatformsInCatalog(catalog(false))).not.toContain('classifierdev');
    expect(keylessPlatformsInCatalog(catalog(true))).toContain('classifierdev');
  });

  it('keeps the first answer: reopening a database does not make it new again', () => {
    setSetting('keyless_defaults', 'done');
    getDb().prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('keyless_defaults', 'pending');
    expect(getSetting('keyless_defaults')).toBe('done');
  });

  it('only counts no-key platforms with enabled rows in the catalog', () => {
    expect(keylessPlatformsInCatalog(FREE_CATALOG)).toEqual(['aihorde', 'kilo', 'ovh', 'parallel']);
    expect(keylessPlatformsInCatalog({ models: [{ platform: 'kilo', enabled: false }] })).toEqual([]);
  });

  it('a free new install gets only what the free catalog lists', () => {
    expect(applyKeylessDefaults(FREE_CATALOG)).toEqual(['aihorde', 'kilo', 'ovh', 'parallel']);
    expect(platforms()).toEqual(['aihorde', 'kilo', 'ovh', 'parallel']);
    expect(getSetting('keyless_defaults')).toBe('done');
  });

  it('a Premium new install gets every no-key provider its catalog lists', () => {
    applyKeylessDefaults(PREMIUM_CATALOG);
    expect(platforms()).toEqual(['aihorde', 'aisense', 'halx', 'keenable', 'kilo', 'ovh', 'parallel']);
  });

  it('runs once: a provider the user removed is not added back by a later sync', () => {
    applyKeylessDefaults(FREE_CATALOG);
    getDb().prepare("DELETE FROM api_keys WHERE platform = 'kilo'").run();
    expect(applyKeylessDefaults(PREMIUM_CATALOG)).toEqual([]);
    expect(platforms()).not.toContain('kilo');
  });

  it('an existing install enables nothing on its own', () => {
    setSetting('keyless_defaults', 'skip');
    expect(applyKeylessDefaults(PREMIUM_CATALOG)).toEqual([]);
    expect(platforms()).toEqual([]);
  });

  it('does not touch a platform that already has a key', () => {
    getDb().prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('kilo', 'mine', 'x', 'y', 'z', 'healthy', 0)").run();
    applyKeylessDefaults(FREE_CATALOG);
    const kilo = getDb().prepare("SELECT label, enabled FROM api_keys WHERE platform = 'kilo'").all();
    expect(kilo).toEqual([{ label: 'mine', enabled: 0 }]);
  });

  describe('the Keys page notice for existing installs', () => {
    beforeEach(() => setSetting('keyless_defaults', 'skip'));

    it('lists what the applied catalog offers and the install has not added', () => {
      applyCatalogJson(FREE_CATALOG);
      getDb().prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('ovh', '', 'x', 'y', 'z', 'healthy', 0)").run();
      expect(availableKeylessProviders().map(p => p.platform)).toEqual(['aihorde', 'kilo', 'parallel']);
    });

    it('lists nothing before any catalog is applied', () => {
      expect(availableKeylessProviders()).toEqual([]);
    });

    it('shows a free install a provider only once the free catalog carries it', () => {
      applyCatalogJson(FREE_CATALOG);
      expect(availableKeylessProviders().map(p => p.platform)).not.toContain('keenable');
      applyCatalogJson(PREMIUM_CATALOG);
      expect(availableKeylessProviders().map(p => p.platform)).toContain('keenable');
    });

    it('Enable all adds them and the notice empties', () => {
      applyCatalogJson(FREE_CATALOG);
      expect(enableAvailableKeylessProviders()).toEqual(['aihorde', 'kilo', 'ovh', 'parallel']);
      expect(platforms()).toEqual(['aihorde', 'kilo', 'ovh', 'parallel']);
      expect(availableKeylessProviders()).toEqual([]);
    });

    it('dismiss hides the current ones, and a provider that arrives later shows again', () => {
      applyCatalogJson(FREE_CATALOG);
      dismissAvailableKeylessProviders();
      expect(availableKeylessProviders()).toEqual([]);
      applyCatalogJson(PREMIUM_CATALOG);
      expect(availableKeylessProviders().map(p => p.platform)).toEqual(['aisense', 'halx', 'keenable']);
    });
  });
});
