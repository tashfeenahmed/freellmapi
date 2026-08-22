import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';

const {
  registerModule,
  enableModule,
  disableModule,
  isModuleEnabled,
  listModules,
  _resetModulesForTesting,
  COMPRESSION_MODULE_ID,
} = await import('../../services/modules.js');
const { COMPRESSION_SETTING, getCompressionConfig } = await import('../../services/compression/config.js');

// #763 pluggable-module registry: a dependency-free register/enable/disable/
// isEnabled surface, with compression wired in as the flagship provider-backed
// module (its enabled state follows the existing `compression` setting).

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  _resetModulesForTesting();
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(COMPRESSION_SETTING);
});

describe('modules registry', () => {
  it('register → list shows the module, disabled by default', () => {
    registerModule({ id: 'paid-models', label: 'Paid Models' });
    const view = listModules().find(m => m.id === 'paid-models');
    expect(view).toEqual({ id: 'paid-models', label: 'Paid Models', enabled: false, providerBacked: false });
    expect(isModuleEnabled('paid-models')).toBe(false);
  });

  it('enable/disable flip the flag', () => {
    registerModule({ id: 'paid-models', label: 'Paid Models' });
    expect(enableModule('paid-models')).toBe(true);
    expect(isModuleEnabled('paid-models')).toBe(true);
    expect(disableModule('paid-models')).toBe(true);
    expect(isModuleEnabled('paid-models')).toBe(false);
  });

  it('unknown module ids are no-ops', () => {
    expect(enableModule('nope')).toBe(false);
    expect(disableModule('nope')).toBe(false);
    expect(isModuleEnabled('nope')).toBe(false);
  });

  it('duplicate registration throws', () => {
    registerModule({ id: 'paid-models', label: 'Paid Models' });
    expect(() => registerModule({ id: 'paid-models', label: 'Duplicate' })).toThrow(/already registered/);
  });

  it('a provider-backed module follows its provider, ignoring enable/disable', () => {
    let on = false;
    registerModule({ id: 'demo', label: 'Demo', isEnabled: () => on });
    expect(isModuleEnabled('demo')).toBe(false);
    enableModule('demo'); // provider wins — still off
    expect(isModuleEnabled('demo')).toBe(false);
    on = true;
    expect(isModuleEnabled('demo')).toBe(true);
    disableModule('demo'); // provider wins — still on
    expect(isModuleEnabled('demo')).toBe(true);
    expect(listModules().find(m => m.id === 'demo')).toMatchObject({ providerBacked: true });
  });
});

describe('modules: flagship compression module', () => {
  it('compression is registered by default', () => {
    expect(isModuleEnabled(COMPRESSION_MODULE_ID)).toBe(false); // mode defaults to 'off'
  });

  it('enabled when the compression mode is not off', () => {
    setSetting(COMPRESSION_SETTING, JSON.stringify({ ...getCompressionConfig(), mode: 'standard' }));
    expect(isModuleEnabled(COMPRESSION_MODULE_ID)).toBe(true);
  });

  it('disabled again when mode returns to off', () => {
    setSetting(COMPRESSION_SETTING, JSON.stringify({ ...getCompressionConfig(), mode: 'standard' }));
    expect(isModuleEnabled(COMPRESSION_MODULE_ID)).toBe(true);
    setSetting(COMPRESSION_SETTING, JSON.stringify({ ...getCompressionConfig(), mode: 'off' }));
    expect(isModuleEnabled(COMPRESSION_MODULE_ID)).toBe(false);
  });
});
