import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import type { Db } from '../../db/types.js';

// Minimal Db wrapper for tests (avoids full app bootstrap).
function createTestDb(): Db {
  const raw = new Database(':memory:');
  const db: Db = {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        get(...params: unknown[]) { return stmt.get(...params) as unknown; },
        all(...params: unknown[]) { return stmt.all(...params) as unknown[]; },
        run(...params: unknown[]) {
          const info = stmt.run(...params);
          return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
        },
      };
    },
    exec(sql: string) { raw.exec(sql); },
    transaction<F extends (...args: unknown[]) => unknown>(fn: F): F { return raw.transaction(fn) as unknown as F; },
    pragma(src: string) { return raw.pragma(src); },
  };

  // Create the combos table
  db.exec(`
    CREATE TABLE IF NOT EXISTS combos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      models TEXT NOT NULL DEFAULT '[]',
      strategy TEXT NOT NULL DEFAULT 'fallback' CHECK (strategy IN ('fallback', 'round-robin', 'fusion')),
      sticky_limit INTEGER NOT NULL DEFAULT 1,
      judge_model TEXT,
      kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'fusion')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_combos_name ON combos(name);
  `);

  return db;
}

import {
  getAllCombos,
  getComboById,
  getComboByName,
  createCombo,
  updateCombo,
  deleteCombo,
  resolveCombo,
  getComboModelIds,
  comboCreateSchema,
  comboUpdateSchema,
  COMBO_NAME_RE,
} from '../../services/combos.js';

describe('combos service', () => {
  let db: Db;

  const VALID_COMBO = {
    name: 'vision-batch',
    description: 'Models for batch vision processing',
    models: ['gemini-2.5-flash', 'google:gemini-2.0-flash-exp'],
    strategy: 'fallback' as const,
    sticky_limit: 1,
    judge_model: null,
    kind: 'chat' as const,
  };

  beforeAll(() => {
    db = createTestDb();
  });

  describe('createCombo', () => {
    it('creates a combo and returns it with an id', () => {
      const combo = createCombo(db, VALID_COMBO);
      expect(combo.id).toBeGreaterThan(0);
      expect(combo.name).toBe('vision-batch');
      expect(combo.models).toEqual(['gemini-2.5-flash', 'google:gemini-2.0-flash-exp']);
      expect(combo.strategy).toBe('fallback');
      expect(combo.stickyLimit).toBe(1);
      expect(typeof combo.createdAt).toBe('string');
    });

    it('rejects duplicate name (UNIQUE constraint)', () => {
      expect(() => createCombo(db, VALID_COMBO)).toThrow();
    });
  });

  describe('getAllCombos', () => {
    it('returns all combos', () => {
      createCombo(db, { ...VALID_COMBO, name: 'coding-premium' });
      const combos = getAllCombos(db);
      expect(combos.length).toBe(2);
      expect(combos.map(c => c.name)).toContain('coding-premium');
    });
  });

  describe('getComboById', () => {
    it('returns a combo by id', () => {
      const combo = getComboById(db, 1);
      expect(combo).not.toBeNull();
      expect(combo!.name).toBe('vision-batch');
    });

    it('returns null for unknown id', () => {
      expect(getComboById(db, 999)).toBeNull();
    });
  });

  describe('getComboByName', () => {
    it('returns a combo by name', () => {
      const combo = getComboByName(db, 'vision-batch');
      expect(combo).not.toBeNull();
      expect(combo!.id).toBe(1);
    });

    it('returns null for unknown name', () => {
      expect(getComboByName(db, 'nonexistent')).toBeNull();
    });
  });

  describe('updateCombo', () => {
    it('updates fields on an existing combo', () => {
      const updated = updateCombo(db, 1, {
        description: 'Updated description',
        strategy: 'round-robin',
        sticky_limit: 3,
      });
      expect(updated).not.toBeNull();
      expect(updated!.description).toBe('Updated description');
      expect(updated!.strategy).toBe('round-robin');
      expect(updated!.stickyLimit).toBe(3);
    });

    it('returns null for unknown id', () => {
      expect(updateCombo(db, 999, { description: 'nope' })).toBeNull();
    });
  });

  describe('deleteCombo', () => {
    it('deletes a combo and returns true', () => {
      // Create a temp combo to delete
      const toDelete = createCombo(db, {
        ...VALID_COMBO, name: 'temp-combo', models: ['test:model'],
      });
      const result = deleteCombo(db, toDelete.id);
      expect(result).toBe(true);
      expect(getComboById(db, toDelete.id)).toBeNull();
    });

    it('returns false for unknown id', () => {
      expect(deleteCombo(db, 999)).toBe(false);
    });
  });

  describe('resolveCombo', () => {
    it('resolves a combo by name', () => {
      const combo = resolveCombo(db, 'vision-batch');
      expect(combo).not.toBeNull();
      expect(combo!.name).toBe('vision-batch');
    });

    it('returns null for strings containing /', () => {
      expect(resolveCombo(db, 'google:gemini-2.0-flash')).toBeNull();
    });

    it('returns null for unknown names', () => {
      expect(resolveCombo(db, 'nonexistent')).toBeNull();
    });
  });

  describe('getComboModelIds', () => {
    it('returns all combo names', () => {
      const ids = getComboModelIds(db);
      expect(ids).toContain('vision-batch');
      expect(ids).toContain('coding-premium');
      expect(ids).not.toContain('google:gemini-2.0-flash');
    });
  });

  describe('validation schemas', () => {
    it('comboCreateSchema rejects invalid names', () => {
      expect(() => comboCreateSchema.parse({ name: 'has space', models: ['a'] }))
        .toThrow();
      expect(() => comboCreateSchema.parse({ name: 'special@chars', models: ['a'] }))
        .toThrow();
      expect(() => comboCreateSchema.parse({ name: 'valid-name_1', models: ['a'] }))
        .not.toThrow();
    });

    it('comboCreateSchema rejects empty models', () => {
      expect(() => comboCreateSchema.parse({ name: 'foo', models: [] }))
        .toThrow();
    });

    it('comboUpdateSchema allows partial updates', () => {
      const result = comboUpdateSchema.parse({ strategy: 'round-robin' });
      expect(result.strategy).toBe('round-robin');
    });

    it('COMBO_NAME_RE rejects invalid characters', () => {
      expect(COMBO_NAME_RE.test('good-name_1')).toBe(true);
      expect(COMBO_NAME_RE.test('bad name')).toBe(false);
      expect(COMBO_NAME_RE.test('bad/name')).toBe(false);
      expect(COMBO_NAME_RE.test('bad@name')).toBe(false);
    });
  });
});
