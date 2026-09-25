/**
 * A very small SQLite-flavoured SQL engine for the in-memory test pool.
 *
 * db/postgres.ts's hand-written shims only understand the handful of statement
 * shapes the fork's own services used before the PostgreSQL migration, so any
 * query outside that list silently returned "no rows" — which is how a schema
 * missing fifteen tables could hide behind a green-looking server. This module
 * gives the mock a real (if simple) executor so the tests exercise the same
 * statements the code writes: SELECT with WHERE/ORDER BY/LIMIT/aggregates,
 * INSERT (incl. upsert), UPDATE and DELETE, with `?` placeholders and the
 * SQLite functions the code uses (datetime('now'), julianday, strftime).
 *
 * TEST INFRASTRUCTURE ONLY. It is never loaded by the real pool: production
 * goes through pg and the call sites are being ported to `pool.query()`.
 */

export type SqlTables = Map<string, any[]>;

export interface SqlResult {
  rows?: any[];
  changes: number;
  lastInsertRowid: number;
}

const NOW_RE = /(?:datetime|CURRENT_TIMESTAMP)\s*\(\s*'?now'?\s*\)|NOW\(\)|CURRENT_TIMESTAMP/i;

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;\s*$/, '');
}

/** Split on a separator, ignoring anything inside quotes or parentheses. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && text.startsWith(sep, i)) {
      out.push(buf.trim());
      buf = '';
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function compare(a: any, b: any): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na < nb ? -1 : na > nb ? 1 : 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function resolveValue(raw: string, params: any[], state: { i: number }): any {
  const v = raw.trim();
  if (v === '?') {
    const val = params[state.i];
    state.i++;
    return val;
  }
  if (/^NULL$/i.test(v)) return null;
  if (/^'(.*)'$/s.test(v)) return v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");
  if (NOW_RE.test(v)) return nowIso();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^-?\d+ms$/i.test(v)) return Number(v.slice(0, -2));
  return v;
}

/** Evaluate a single WHERE term against a row. */
function evalTerm(row: any, term: string, params: any[], state: { i: number }): boolean {
  const t = term.trim();
  if (!t) return true;
  const m = t.match(/^([A-Za-z_][\w.]*)\s+(LIKE|NOT\s+LIKE)\s+(.+)$/i);
  if (m) {
    const col = m[1].split('.').pop()!;
    const pat = resolveValue(m[3], params, state);
    const hit = likeToRegExp(String(pat ?? '')).test(String(row[col] ?? ''));
    return m[2].toUpperCase().startsWith('NOT') ? !hit : hit;
  }
  const inM = t.match(/^([A-Za-z_][\w.]*)\s+(NOT\s+)?IN\s*\((.*)\)$/i);
  if (inM) {
    const col = inM[1].split('.').pop()!;
    const negate = Boolean(inM[2]);
    const items = splitTop(inM[3], ',').map(x => resolveValue(x, params, state));
    const hit = items.some(v => compare(row[col], v) === 0);
    return negate ? !hit : hit;
  }
  const isM = t.match(/^([A-Za-z_][\w.]*)\s+IS\s+(NOT\s+)?NULL$/i);
  if (isM) {
    const col = isM[1].split('.').pop()!;
    const isNull = row[col] === null || row[col] === undefined;
    return isM[2] ? !isNull : isNull;
  }
  const cmpM = t.match(/^([A-Za-z_][\w.]*)\s*(>=|<=|<>|!=|=|>|<)\s*(.+)$/);
  if (cmpM) {
    const col = cmpM[1].split('.').pop()!;
    const op = cmpM[2];
    const rhs = resolveValue(cmpM[3], params, state);
    const c = compare(row[col], rhs);
    switch (op) {
      case '=': return c === 0;
      case '!=': case '<>': return c !== 0;
      case '>': return c > 0;
      case '>=': return c >= 0;
      case '<': return c < 0;
      case '<=': return c <= 0;
    }
  }
  if (/^[A-Za-z_][\w.]*$/.test(t)) {
    const v = row[t.split('.').pop()!];
    return !(v === null || v === undefined || v === 0 || v === false || v === '');
  }
  return true;
}

function matchesWhere(row: any, where: string | undefined, params: any[], state = { i: 0 }): boolean {
  if (!where) return true;
  return splitTop(where, ' OR ').some(group =>
    splitTop(group, ' AND ').every(term => evalTerm(row, term, params, state)));
}

function sortRows(rows: any[], orderBy: string | undefined): any[] {
  if (!orderBy) return rows;
  const specs = splitTop(orderBy, ',').map(spec => {
    const m = spec.trim().match(/^(.+?)(?:\s+(ASC|DESC))?$/i);
    return {
      col: (m?.[1] || spec).trim().split('.').pop()!,
      desc: (m?.[2] || 'ASC').toUpperCase() === 'DESC',
    };
  });
  return [...rows].sort((a, b) => {
    for (const { col, desc } of specs) {
      const c = compare(a[col], b[col]);
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  });
}

const AGGREGATES: Record<string, (vals: any[]) => any> = {
  COUNT: vals => vals.length,
  MAX: vals => vals.reduce((a, b) => (compare(b, a) > 0 ? b : a), undefined),
  MIN: vals => vals.reduce((a, b) => (compare(b, a) < 0 ? b : a), undefined),
  SUM: vals => vals.reduce((sum, v) => sum + (Number(v) || 0), 0),
  AVG: vals => (vals.length ? vals.reduce((s, v) => s + (Number(v) || 0), 0) / vals.length : null),
};

function project(rows: any[], selectList: string, params: any[]): any[] {
  const cols = splitTop(selectList, ',').map(c => c.trim()).filter(Boolean);
  if (cols.length === 1 && cols[0] === '*') return rows;
  if (!rows.length) return [];

  const isAggregate = cols.some(c => /^(COUNT|MAX|MIN|SUM|AVG)\s*\(/i.test(c));
  if (isAggregate) {
    const out: any = {};
    for (const col of cols) {
      const agg = col.match(/^(COUNT|MAX|MIN|SUM|AVG)\s*\(\s*([^)]*)\s*\)(?:\s+AS\s+(\w+))?$/i);
      if (!agg) continue;
      const fn = AGGREGATES[agg[1].toUpperCase()];
      const target = agg[2].trim();
      const vals = rows.map(r => (target === '*' ? 1 : r[target.split('.').pop()!]))
        .filter(v => v !== null && v !== undefined);
      out[agg[3] || agg[1].toLowerCase()] = fn ? fn(vals) : null;
    }
    return [out];
  }

  return rows.map(row => {
    const out: any = {};
    for (const col of cols) {
      const alias = col.match(/\s+AS\s+(\w+)$/i)?.[1];
      const expr = col.replace(/\s+AS\s+\w+$/i, '').trim();
      if (/^(datetime|CURRENT_TIMESTAMP)\s*\(/i.test(expr) || /^NOW\(\)$/i.test(expr)) {
        out[alias || 'now'] = nowIso();
        continue;
      }
      if (/^COALESCE\s*\(/i.test(expr)) {
        const args = splitTop(expr.replace(/^COALESCE\s*\(/i, '').replace(/\)$/, ''), ',');
        const first = args.map(a => resolveValue(a, params, { i: 0 })).find(v => v !== null && v !== undefined);
        out[alias || 'coalesce'] = first ?? null;
        continue;
      }
      out[alias || expr.split('.').pop()!] = row[expr.split('.').pop()!];
    }
    return out;
  });
}

function tableRows(tables: SqlTables, name: string): any[] {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name)!;
}

/**
 * Execute one statement against the in-memory tables.
 * Returns `null` when the statement is outside what this engine understands, so
 * the caller can fall back to its own hand-written handling.
 */
export function execStatement(
  tables: SqlTables,
  sql: string,
  params: any[] = [],
  nextId: () => number = () => 1,
): SqlResult | null {
  const s = normalize(sql);
  if (!s) return null;
  if (/^(BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP|PRAGMA|VACUUM|ANALYZE)/i.test(s)) {
    return { changes: 0, lastInsertRowid: 0 };
  }

  // ── SELECT ────────────────────────────────────────────────────────────────
  const sel = s.match(/^SELECT\s+(?:DISTINCT\s+)?(.+?)\s+FROM\s+([A-Za-z_][\w]*)(.*)$/i);
  if (sel) {
    if (/\sJOIN\b/i.test(sel[3])) return null; // joins stay with the specific shims
    const [, selectList, table, rest] = sel;
    const whereM = rest.match(/\bWHERE\b(.+?)(?=\bORDER\b|\bLIMIT\b|$)/i);
    const orderM = rest.match(/\bORDER\s+BY\s+(.+?)(?=\bLIMIT\b|$)/i);
    const limitM = rest.match(/\bLIMIT\s+(\d+|\?)(?:\s+OFFSET\s+(\d+|\?))?/i);
    // The WHERE's placeholders re-bind for every row, so each evaluation starts
    // from the same offset; LIMIT/OFFSET then continue from where the WHERE left
    // the cursor, which is exactly the order they appear in the statement.
    const state = { i: 0 };
    const whereBase = state.i;
    const rows = tableRows(tables, table.toLowerCase())
      .filter(r => matchesWhere(r, whereM?.[1], params, { i: whereBase }));
    let out = sortRows(rows, orderM?.[1]);
    if (limitM) {
      const limit = Number(resolveValue(limitM[1], params, state));
      const offset = limitM[2] ? Number(resolveValue(limitM[2], params, state)) : 0;
      out = out.slice(offset, offset + limit);
    }
    return { rows: project(out, selectList, params), changes: 0, lastInsertRowid: 0 };
  }

  // ── INSERT (incl. ON CONFLICT upsert) ─────────────────────────────────────
  const ins = s.match(/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*VALUES\s*\((.*?)\)\s*(.*)$/i);
  if (ins) {
    const [, table, colList, valList, tail] = ins;
    const rows = tableRows(tables, table.toLowerCase());
    const state = { i: 0 };
    const cols = colList ? splitTop(colList, ',').map(c => c.trim()) : Object.keys(rows[0] || {});
    const values = splitTop(valList, ',').map(v => resolveValue(v, params, state));

    const record: any = { id: nextId(), created_at: nowIso(), updated_at: nowIso() };
    cols.forEach((c, i) => { record[c] = values[i]; });
    if (record.enabled === undefined) record.enabled = 1;

    const conflictCols = tail.match(/ON\s+CONFLICT\s*\(([^)]*)\)(?:\s+WHERE\s+(.+?))?(?:\s+DO\s+(NOTHING|UPDATE))?/i);
    if (conflictCols) {
      const keys = splitTop(conflictCols[1], ',').map(c => c.trim().split('.').pop()!);
      const existing = rows.find(r => keys.every(k => compare(r[k], record[k]) === 0));
      if (existing) {
        // conflictCols[3] is the ACTION word on its own ('UPDATE' / 'NOTHING').
        if (!/UPDATE/i.test(conflictCols[3] || '')) {
          return { changes: 0, lastInsertRowid: existing.id ?? 0 };
        }
        // The SET list follows `DO UPDATE` in the tail; the conflict regex only
        // captures the action keyword, so read the assignments from `tail`.
        const setM = tail.match(/\bDO\s+UPDATE\s+SET\s+(.+)$/i);
        if (setM) {
          // `excluded.<col>` must read the row the INSERT wanted to write, and
          // any placeholders left in the SET list come after the VALUES ones.
          applyResolved(existing, resolveAssignments(setM[1], params, state, record));
        }
        return { changes: 1, lastInsertRowid: existing.id ?? 0 };
      }
    }

    rows.push(record);
    return { changes: 1, lastInsertRowid: record.id };
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  const upd = s.match(/^UPDATE\s+([A-Za-z_][\w]*)\s+SET\s+(.+?)(?=\bWHERE\b|$)/i);
  if (upd) {
    const [, table, assignments] = upd;
    const whereM = s.match(/\bWHERE\b(.+)$/i);
    const rows = tableRows(tables, table.toLowerCase());
    // The SET placeholders are bound before the WHERE ones (that is the order
    // they appear in the statement), so resolve them up front; the WHERE's own
    // placeholders then re-bind from that offset for every candidate row.
    const state = { i: 0 };
    const resolved = resolveAssignments(assignments, params, state);
    const whereBase = state.i;
    let changes = 0;
    for (const row of rows) {
      if (!matchesWhere(row, whereM?.[1], params, { i: whereBase })) continue;
      applyResolved(row, resolved);
      changes++;
    }
    return { changes, lastInsertRowid: 0 };
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  const del = s.match(/^DELETE\s+FROM\s+([A-Za-z_][\w]*)(?:\s+WHERE\b(.+))?$/i);
  if (del) {
    const [, table, where] = del;
    const rows = tableRows(tables, table.toLowerCase());
    const keep = rows.filter(r => !matchesWhere(r, where, params));
    const changes = rows.length - keep.length;
    tables.set(table.toLowerCase(), keep);
    return { changes, lastInsertRowid: 0 };
  }

  return null;
}

/**
 * Turn a `col = expr, ...` list into resolved values. `excluded.<col>` refers to
 * the row the INSERT was trying to write (Postgres' upsert syntax), which the
 * caller passes as `incoming`.
 */
function resolveAssignments(
  assignments: string,
  params: any[],
  state: { i: number },
  incoming?: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const assign of splitTop(assignments, ',')) {
    const m = assign.match(/^([A-Za-z_][\w.]*)\s*=\s*(.+)$/);
    if (!m) continue;
    const col = m[1].split('.').pop()!;
    const expr = m[2].trim();
    const excluded = expr.match(/^excluded\.([A-Za-z_]\w*)$/i);
    out[col] = excluded && incoming ? incoming[excluded[1]] : resolveValue(expr, params, state);
  }
  return out;
}

function applyResolved(row: any, resolved: Record<string, any>): void {
  for (const [col, value] of Object.entries(resolved)) row[col] = value;
  row.updated_at = nowIso();
}
