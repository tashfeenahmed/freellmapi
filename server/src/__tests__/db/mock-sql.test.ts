import { describe, it, expect, beforeEach } from 'vitest';
import { execStatement, type SqlTables } from '../../db/mock-sql.js';

// The in-memory pool used to answer "no rows" for every table the PostgreSQL
// migration had not recreated, which is how a missing schema stayed invisible.
// These pin the small engine that replaced that behaviour.
describe('mock SQL engine', () => {
  let tables: SqlTables;
  let id = 1;
  const nextId = () => id++;

  const run = (sql: string, params: any[] = []) => execStatement(tables, sql, params, nextId);

  beforeEach(() => {
    id = 1;
    tables = new Map<string, any[]>([['profiles', []]]);
  });

  it('inserts and reads rows back with a WHERE filter', () => {
    const ins = run(
      `INSERT INTO profiles (name, emoji, sort_order) VALUES (?, ?, ?)`,
      ['work', '💼', 2],
    );
    expect(ins?.lastInsertRowid).toBe(1);
    run(`INSERT INTO profiles (name, sort_order) VALUES (?, ?)`, ['home', 1]);

    const rows = run(`SELECT id, name, sort_order FROM profiles WHERE sort_order > ? ORDER BY sort_order ASC`, [1]);
    expect(rows?.rows).toEqual([{ id: 1, name: 'work', sort_order: 2 }]);
  });

  it('defaults an absent column and honours LIMIT/OFFSET', () => {
    for (const [name, order] of [['a', 3], ['b', 1], ['c', 2]] as const) {
      run(`INSERT INTO profiles (name, sort_order) VALUES (?, ?)`, [name, order]);
    }
    const page = run(`SELECT name FROM profiles ORDER BY sort_order ASC LIMIT ? OFFSET ?`, [1, 1]);
    expect(page?.rows).toEqual([{ name: 'c' }]);
  });

  it('evaluates AND / OR, IN, LIKE and IS NULL', () => {
    run(`INSERT INTO profiles (name, emoji) VALUES (?, ?)`, ['a', '']);
    run(`INSERT INTO profiles (name, emoji) VALUES (?, ?)`, ['b', 'x']);
    run(`INSERT INTO url_tokens (token_hash, label, token_prefix) VALUES (?, ?, ?)`, ['h1', 'one', 'sk-']);
    run(`INSERT INTO url_tokens (token_hash, label, token_prefix) VALUES (?, ?, ?)`, ['h2', 'two', 'sk-']);

    expect(run(`SELECT name FROM profiles WHERE emoji = '' OR name = 'b'`)?.rows)
      .toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(run(`SELECT name FROM profiles WHERE name IN (?, ?)`, ['a', 'c'])?.rows)
      .toEqual([{ name: 'a' }]);
    expect(run(`SELECT label FROM url_tokens WHERE token_hash LIKE ?`, ['h%'])?.rows)
      .toHaveLength(2);
    expect(run(`SELECT name FROM profiles WHERE emoji IS NULL`)?.rows).toEqual([]);
  });

  it('computes aggregates', () => {
    run(`INSERT INTO profiles (name, sort_order) VALUES (?, ?)`, ['a', 1]);
    run(`INSERT INTO profiles (name, sort_order) VALUES (?, ?)`, ['b', 4]);
    const r = run(`SELECT COUNT(*) AS n, MAX(sort_order) AS top FROM profiles`);
    expect(r?.rows).toEqual([{ n: 2, top: 4 }]);
  });

  it('updates matching rows and reports how many changed', () => {
    run(`INSERT INTO profiles (name, sort_order) VALUES (?, ?)`, ['a', 1]);
    run(`INSERT INTO profiles (name, sort_order) VALUES (?, ?)`, ['b', 1]);
    const upd = run(`UPDATE profiles SET sort_order = ? WHERE sort_order = ?`, [7, 1]);
    expect(upd?.changes).toBe(2);
    expect(run(`SELECT sort_order FROM profiles WHERE name = 'b'`)?.rows).toEqual([{ sort_order: 7 }]);
  });

  it('deletes matching rows only', () => {
    run(`INSERT INTO profiles (name) VALUES (?)`, ['keep']);
    run(`INSERT INTO profiles (name) VALUES (?)`, ['drop']);
    const del = run(`DELETE FROM profiles WHERE name = ?`, ['drop']);
    expect(del?.changes).toBe(1);
    expect(run(`SELECT name FROM profiles`)?.rows).toEqual([{ name: 'keep' }]);
  });

  it('upserts on conflict instead of duplicating the row', () => {
    const sql = `INSERT INTO settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    run(sql, ['a', '1']);
    run(sql, ['a', '2']);
    run(sql, ['b', '3']);
    expect(run(`SELECT key, value FROM settings ORDER BY key ASC`)?.rows)
      .toEqual([{ key: 'a', value: '2' }, { key: 'b', value: '3' }]);
  });

  it('treats DDL and unknown statements as no-ops / unsupported', () => {
    expect(run(`CREATE TABLE IF NOT EXISTS x (id INTEGER)`)?.changes).toBe(0);
    expect(run(`SELECT a.id FROM a JOIN b ON b.id = a.id`)).toBeNull();
    expect(run(`PRAGMA table_info(profiles)`)?.changes).toBe(0);
  });
});
