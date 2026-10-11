import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MIN_CONTEXT_WINDOW_SETTING,
  MIN_CONTEXT_WINDOW_PRESETS,
  minContextWindowFloor,
  passesContextWindowFloor,
} from '../../lib/min-context-window.js';
import { initDb, getDb, setSetting, getSetting } from '../../db/index.js';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

afterEach(() => {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(MIN_CONTEXT_WINDOW_SETTING);
});

describe('minContextWindowFloor', () => {
  it('is disabled by default (off / unset)', () => {
    expect(minContextWindowFloor()).toBeNull();
    setSetting(MIN_CONTEXT_WINDOW_SETTING, 'off');
    expect(minContextWindowFloor()).toBeNull();
  });

  it('resolves the named presets to their token counts', () => {
    for (const [key, tokens] of Object.entries(MIN_CONTEXT_WINDOW_PRESETS)) {
      setSetting(MIN_CONTEXT_WINDOW_SETTING, key);
      expect(minContextWindowFloor()).toBe(tokens);
    }
  });

  it('is case-insensitive', () => {
    setSetting(MIN_CONTEXT_WINDOW_SETTING, '128K');
    expect(minContextWindowFloor()).toBe(131_072);
  });

  it('treats garbage as disabled so a bad value can never empty the pool', () => {
    for (const raw of ['banana', '-1', '1.5', 'NaN', 'Infinity', '{}']) {
      setSetting(MIN_CONTEXT_WINDOW_SETTING, raw);
      expect(minContextWindowFloor()).toBeNull();
    }
  });
});

describe('passesContextWindowFloor', () => {
  it('passes everything while disabled', () => {
    expect(passesContextWindowFloor(8_000)).toBe(true);
    expect(passesContextWindowFloor(null)).toBe(true);
  });

  it('is upward-compatible: 128k keeps 512k and 1M models', () => {
    setSetting(MIN_CONTEXT_WINDOW_SETTING, '128k');
    expect(passesContextWindowFloor(131_072)).toBe(true);
    expect(passesContextWindowFloor(524_288)).toBe(true);
    expect(passesContextWindowFloor(1_048_576)).toBe(true);
    expect(passesContextWindowFloor(32_768)).toBe(false);
  });

  it('never filters an unknown (null) window', () => {
    setSetting(MIN_CONTEXT_WINDOW_SETTING, '1m');
    expect(passesContextWindowFloor(null)).toBe(true);
    expect(passesContextWindowFloor(undefined)).toBe(true);
  });

  it('rejects models strictly below the floor', () => {
    setSetting(MIN_CONTEXT_WINDOW_SETTING, '32k');
    expect(passesContextWindowFloor(16_000)).toBe(false);
    expect(passesContextWindowFloor(32_768)).toBe(true);
  });

  it('reads through the same settings row the PUT endpoint writes', () => {
    setSetting(MIN_CONTEXT_WINDOW_SETTING, '512k');
    expect(getSetting(MIN_CONTEXT_WINDOW_SETTING)).toBe('512k');
    expect(minContextWindowFloor()).toBe(524_288);
  });
});
