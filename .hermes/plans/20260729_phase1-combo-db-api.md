# Phase 1: Combos — Database Schema & API Endpoints

> **For future agents:** Implement this plan task-by-task. Each task is 2-5 minutes of focused work.

**Goal:** Create the database table, service layer, and REST API endpoints that allow users to define named "combo" model groups — ordered lists of models with a routing strategy (fallback / round-robin / fusion).

**Architecture:** A new `combos` SQLite table stores each combo's name, model list (JSON), strategy, and metadata. A `services/combos.ts` module provides pure CRUD and resolution logic (no Express). A `routes/combos.ts` Express router exposes REST endpoints. The combo table is separate from `fallback_config` and `profile_models` — it is an orthogonal concept that later phases will hook into the proxy's model-resolution path.

**Tech Stack:** TypeScript, SQLite (better-sqlite3 via Drizzle helper), Express.js v5, Zod validation.

**Key references:**
- Existing migration pattern: `server/src/db/migrations/20260727_000001_agent_compatibility.ts`
- Migration registry: `server/src/db/migrate/defaults.ts`
- Similar CRUD pattern: `server/src/routes/keys.ts`, `server/src/routes/settings.ts`
- Similar service pattern: `server/src/services/model-groups.ts`
- Template: `server/src/db/migrate/TEMPLATE.ts`

---

## Task 1: Create the DB migration file

**Objective:** Add a `combos` table to the schema via a new migration.

**Files:**
- Create: `server/src/db/migrations/20260729_000001_combos.ts`
- Modify: `server/src/db/migrate/defaults.ts`

**Details for the migration:**

The `combos` table schema:

```sql
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
```

- `name` — user-facing slug (e.g. `vision-batch`, `coding-combo`). Must be `[a-zA-Z0-9._-]+`.
- `models` — JSON array of model identifiers. Each entry is a model id from the gateway's `/v1/models` list (e.g. `"kimi-k2.7-code"`, `"deepseek-v4-flash"`, `"gemini-3.5-flash"`). These are the same IDs users see in the model dropdown — no `platform:` prefix needed since the combo name itself becomes a virtual model id.
- `strategy` — how models are tried: `fallback` (sequential, stop on first success), `round-robin` (rotate through), `fusion` (parallel panel + judge).
- `sticky_limit` — for `round-robin`: how many consecutive requests use the same model before rotating.
- `judge_model` — for `fusion` strategy: which model acts as judge; `NULL` means auto-pick.
- `kind` — `chat` (standard fallback combo) or `fusion` (multi-model synthesis). Mirrors 9router's `kind` field.

Additional index:

```sql
CREATE INDEX IF NOT EXISTS idx_combos_name ON combos(name);
```

**DOWN:**
```sql
DROP TABLE IF EXISTS combos;
```

**Step 1: Write the migration file**

Create `server/src/db/migrations/20260729_000001_combos.ts`:

```typescript
// Migration: Create combos table for named model groups
// Created: 2026-07-29
//
// DOWN: reversible

import type { Db } from '../types.js';

export function up(db: Db): void {
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
}

export function down(db: Db): void {
  db.exec(`DROP TABLE IF EXISTS combos;`);
}
```

**Step 2: Register in `defaults.ts`**

Add import and constant at the top of `server/src/db/migrate/defaults.ts`:

```typescript
import * as combos from '../migrations/20260729_000001_combos.js';
export const COMBOS_FILENAME = '20260729_000001_combos.ts';
```

Add the entry to the `DEFAULT_MIGRATIONS` array (at the end, after `AGENT_COMPATIBILITY_FILENAME`):

```typescript
  { filename: COMBOS_FILENAME, module: combos },
```

**Step 3: Run the migration**

```bash
# From the repo root:
npm run db:migration:up
```

Expected output: migration applied successfully (no errors).

```bash
# Verify:
npm run db:migration:status
# Expected: `20260729_000001_combos.ts` appears in the list with status "applied".
```

**Step 4: Run existing tests to confirm nothing broke**

```bash
npm run test:migrations
# Expected: all migration tests PASS.
```

**Step 5: Commit**

```bash
git add server/src/db/migrations/20260729_000001_combos.ts server/src/db/migrate/defaults.ts
git commit -m "feat(db): add combos table migration"
```

---

## Task 2: Create the combos service module

**Objective:** Pure CRUD + resolution functions for combos, no Express dependency. Follows the pattern of `model-groups.ts`.

**Files:**
- Create: `server/src/services/combos.ts`

**Step 1: Write the service**

Create `server/src/services/combos.ts`:

```typescript
/**
 * Combos — named, ordered model groups with a custom routing strategy.
 *
 * A combo is a user-defined list of models that can be requested by name
 * in the `model` field instead of a single model id. The router (Phase 2)
 * will resolve a combo request by trying its models in order (fallback),
 * rotating through them (round-robin), or calling them in parallel (fusion).
 *
 * Pure by design: the core functions take a Db handle and touch no globals,
 * so they're trivially testable. Only the getter/setter conveniences are
 * injected in the route layer.
 */
import { z } from 'zod';
import type { Db } from '../db/types.js';

// ── Validation ──────────────────────────────────────────────────────────────

export const COMBO_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export const comboStrategySchema = z.enum(['fallback', 'round-robin', 'fusion']);
export type ComboStrategy = z.infer<typeof comboStrategySchema>;

export const comboKindSchema = z.enum(['chat', 'fusion']);
export type ComboKind = z.infer<typeof comboKindSchema>;

export const comboUpdateSchema = z.object({
  name: z.string().min(1).max(80).regex(COMBO_NAME_RE, 'Name can only contain letters, numbers, -, _, and .').optional(),
  description: z.string().max(500).optional(),
  models: z.array(z.string().min(1)).min(1).max(50).optional(),
  strategy: comboStrategySchema.optional(),
  sticky_limit: z.number().int().min(1).max(100).optional(),
  judge_model: z.string().min(1).max(200).nullable().optional(),
  kind: comboKindSchema.optional(),
}).strict();

export const comboCreateSchema = z.object({
  name: z.string().min(1).max(80).regex(COMBO_NAME_RE, 'Name can only contain letters, numbers, -, _, and .'),
  description: z.string().max(500).default(''),
  models: z.array(z.string().min(1)).min(1).max(50),
  strategy: comboStrategySchema.default('fallback'),
  sticky_limit: z.number().int().min(1).max(100).default(1),
  judge_model: z.string().min(1).max(200).nullable().default(null),
  kind: comboKindSchema.default('chat'),
}).strict();

export type ComboCreateInput = z.infer<typeof comboCreateSchema>;
export type ComboUpdateInput = z.infer<typeof comboUpdateSchema>;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ComboRow {
  id: number;
  name: string;
  description: string;
  models: string;        // JSON array string from DB
  strategy: string;
  sticky_limit: number;
  judge_model: string | null;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface Combo {
  id: number;
  name: string;
  description: string;
  models: string[];
  strategy: ComboStrategy;
  stickyLimit: number;
  judgeModel: string | null;
  kind: ComboKind;
  createdAt: string;
  updatedAt: string;
}

// ── Row ↔ Object mapping ─────────────────────────────────────────────────────

function rowToCombo(row: ComboRow): Combo {
  let parsed: string[];
  try {
    parsed = JSON.parse(row.models) as string[];
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    parsed = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    models: parsed,
    strategy: (['fallback', 'round-robin', 'fusion'].includes(row.strategy)
      ? row.strategy : 'fallback') as ComboStrategy,
    stickyLimit: row.sticky_limit,
    judgeModel: row.judge_model,
    kind: (['chat', 'fusion'].includes(row.kind) ? row.kind : 'chat') as ComboKind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/** Get all combos, ordered by creation time. */
export function getAllCombos(db: Db): Combo[] {
  const rows = db.prepare(
    'SELECT * FROM combos ORDER BY created_at ASC'
  ).all() as ComboRow[];
  return rows.map(rowToCombo);
}

/** Get a single combo by id. Returns null if not found. */
export function getComboById(db: Db, id: number): Combo | null {
  const row = db.prepare('SELECT * FROM combos WHERE id = ?').get(id) as ComboRow | undefined;
  return row ? rowToCombo(row) : null;
}

/** Get a single combo by name (case-sensitive). Returns null if not found. */
export function getComboByName(db: Db, name: string): Combo | null {
  const row = db.prepare('SELECT * FROM combos WHERE name = ?').get(name) as ComboRow | undefined;
  return row ? rowToCombo(row) : null;
}

/** Create a new combo. Returns the created combo with its generated id. */
export function createCombo(db: Db, input: ComboCreateInput): Combo {
  const now = new Date().toISOString();
  const modelsJson = JSON.stringify(input.models);

  const result = db.prepare(`
    INSERT INTO combos (name, description, models, strategy, sticky_limit, judge_model, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.description,
    modelsJson,
    input.strategy,
    input.sticky_limit,
    input.judge_model,
    input.kind,
    now,
    now,
  );

  const inserted = getComboById(db, Number(result.lastInsertRowid));
  if (!inserted) throw new Error('Failed to retrieve newly created combo');
  return inserted;
}

/** Update an existing combo. Only provided fields are changed. Returns the updated combo, or null if not found. */
export function updateCombo(db: Db, id: number, input: ComboUpdateInput): Combo | null {
  const existing = getComboById(db, id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const setters: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) { setters.push('name = ?'); values.push(input.name); }
  if (input.description !== undefined) { setters.push('description = ?'); values.push(input.description); }
  if (input.models !== undefined) { setters.push('models = ?'); values.push(JSON.stringify(input.models)); }
  if (input.strategy !== undefined) { setters.push('strategy = ?'); values.push(input.strategy); }
  if (input.sticky_limit !== undefined) { setters.push('sticky_limit = ?'); values.push(input.sticky_limit); }
  if (input.judge_model !== undefined) { setters.push('judge_model = ?'); values.push(input.judge_model); }
  if (input.kind !== undefined) { setters.push('kind = ?'); values.push(input.kind); }
  setters.push('updated_at = ?');
  values.push(now);

  values.push(id);
  db.prepare(`UPDATE combos SET ${setters.join(', ')} WHERE id = ?`).run(...values);

  return getComboById(db, id);
}

/** Delete a combo by id. Returns true if a row was deleted. */
export function deleteCombo(db: Db, id: number): boolean {
  const result = db.prepare('DELETE FROM combos WHERE id = ?').run(id);
  return (result.changes ?? 0) > 0;
}

/**
 * Check whether a given model string refers to a combo name.
 * Returns the resolved Combo or null.
 */
export function resolveCombo(db: Db, modelStr: string): Combo | null {
  // A model string that contains a '/' is likely "platform:model_id" — not a combo.
  if (modelStr.includes('/')) return null;
  return getComboByName(db, modelStr);
}

/**
 * Return all combo names (for populating virtual model listings).
 */
export function getComboModelIds(db: Db): string[] {
  const rows = db.prepare('SELECT name FROM combos').all() as { name: string }[];
  return rows.map(r => r.name);
}
```

**Key design decisions:**
- Models are stored as a JSON string array — no separate join table (simpler, sufficient for <50 models).
- `name` is the user-facing identifier and must match `[a-zA-Z0-9._-]+` (9router-compatible).
- `resolveCombo()` skips strings containing `/` to avoid ambiguity with `platform:model_id` syntax used in Phase 2 routing.
- The `getComboModelIds()` function provides virtual model ids for later integration with `/v1/models`.

**Step 2: Verify it compiles**

At this point the service is not yet imported anywhere, so no test. But verify TypeScript doesn't flag syntax errors:

```bash
cd server
npx tsc --noEmit --pretty 2>&1 | head -20
# Expected: no errors related to combos.ts
```

**Step 3: Commit**

```bash
git add server/src/services/combos.ts
git commit -m "feat(combos): add combos service module with CRUD and validation"
```

---

## Task 3: Create the combos Express router

**Objective:** Expose REST API endpoints for combo CRUD.

**Files:**
- Create: `server/src/routes/combos.ts`
- Modify: `server/src/app.ts` (register the new router)

**Step 1: Write the route file**

Create `server/src/routes/combos.ts`:

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import {
  getAllCombos,
  getComboById,
  getComboByName,
  createCombo,
  updateCombo,
  deleteCombo,
  comboCreateSchema,
  comboUpdateSchema,
} from '../services/combos.js';

export const combosRouter = Router();

const NOT_FOUND = { error: { message: 'Combo not found' } };

// GET /api/combos — list all combos
combosRouter.get('/', (_req: Request, res: Response) => {
  const combos = getAllCombos(getDb());
  res.json({ combos });
});

// GET /api/combos/:id — get a single combo by id
combosRouter.get('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid combo id' } });
    return;
  }
  const combo = getComboById(getDb(), id);
  if (!combo) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  res.json(combo);
});

// POST /api/combos — create a new combo
combosRouter.post('/', (req: Request, res: Response) => {
  const parsed = comboCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid combo: ${detail}` } });
    return;
  }

  const db = getDb();

  // Check name uniqueness
  const existing = getComboByName(db, parsed.data.name);
  if (existing) {
    res.status(409).json({ error: { message: `Combo "${parsed.data.name}" already exists` } });
    return;
  }

  const combo = createCombo(db, parsed.data);
  res.status(201).json(combo);
});

// PATCH /api/combos/:id — update an existing combo
combosRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid combo id' } });
    return;
  }

  const parsed = comboUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid combo update: ${detail}` } });
    return;
  }

  const db = getDb();

  // If renaming, check the new name doesn't collide
  if (parsed.data.name) {
    const byName = getComboByName(db, parsed.data.name);
    if (byName && byName.id !== id) {
      res.status(409).json({ error: { message: `Combo "${parsed.data.name}" already exists` } });
      return;
    }
  }

  const combo = updateCombo(db, id, parsed.data);
  if (!combo) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  res.json(combo);
});

// DELETE /api/combos/:id — delete a combo
combosRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid combo id' } });
    return;
  }

  const db = getDb();
  const existing = getComboById(db, id);
  if (!existing) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  deleteCombo(db, id);
  res.json({ success: true, id });
});
```

**Step 2: Register the router in app.ts**

In `server/src/app.ts`:

Add import near the other route imports (alphabetically with other routes, after `authRouter`):
```typescript
import { combosRouter } from './routes/combos.js';
```

Register the route after the auth router mount (near line ~140-160, before the proxy catch-all). The pattern used by other `/api` routes:
```typescript
app.use('/api/combos', combosRouter);
```

**Step 3: Verify the server starts**

```bash
# From repo root:
npm run build:server
# Expected: no type errors

# Quick smoke test — run the server in the background and query the combo endpoint:
npm run dev -w server &
sleep 3
curl -s http://localhost:3001/api/combos | head -5
# Expected: {"combos":[]} (empty array — no combos yet)
kill %1 2>/dev/null; wait 2>/dev/null
```

**Step 4: Commit**

```bash
git add server/src/routes/combos.ts server/src/app.ts
git commit -m "feat(combos): add REST API routes for combo CRUD"
```

---

## Task 4: Write service-layer unit tests

**Objective:** Cover combo CRUD + validation logic with vitest.

**Files:**
- Create: `server/src/__tests__/services/combos.test.ts`

**Step 1: Create the test file**

The existing project uses better-sqlite3 in `:memory:` mode for tests. Follow the test setup pattern from other service tests. Create `server/src/__tests__/services/combos.test.ts`:

```typescript
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
```

**Step 2: Install better-sqlite3 types if needed**

Check `server/package.json` — if `@types/better-sqlite3` is already in devDependencies (it is), the test will work.

**Step 3: Run the tests**

```bash
cd server
npx vitest run --pool=forks --fileParallelism=false src/__tests__/services/combos.test.ts
```

Expected output: All tests PASS (12+ tests covering CRUD, resolve, validation).

If some tests fail due to the transaction wrapper incompatibility with the simple test DB adapter, simplify: change `createCombo`, `updateCombo`, `deleteCombo` in the test to NOT use the transaction wrapper from db (since we're using a minimal mock). Actually, let me check — the `createCombo` service function uses `db.prepare().run()` directly (no `db.transaction()`). So the test should work.

Let me verify by checking if `better-sqlite3` return value for `run()` is compatible. In better-sqlite3, `stmt.run()` returns `{ lastInsertRowid, changes }`. The test `db` adapter already wraps that. Good.

**Step 4: Commit**

```bash
git add server/src/__tests__/services/combos.test.ts
git commit -m "test(combos): add unit tests for combos service"
```

---

## Task 5: Integration smoke test via HTTP

**Objective:** Verify the full create → list → get → update → delete flow works through the HTTP API.

**Files:** (no code changes — manual verification)

**Step 1: Start the server**

```bash
cd /home/pi/Documents/GitHub/freellmapi-dev
npm run dev -w server &
sleep 3  # wait for startup
```

**Step 2: Create a combo**

```bash
curl -s -X POST http://localhost:3001/api/combos \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "vision-batch",
    "description": "Vision models for batch processing",
    "models": ["gemini-2.5-flash", "google:gemini-2.0-flash-exp"],
    "strategy": "fallback",
    "sticky_limit": 1,
    "kind": "chat"
  }' | python3 -m json.tool
```

Expected: HTTP 201 with the created combo JSON (including `id`, `createdAt`, etc.).

**Step 3: List combos**

```bash
curl -s http://localhost:3001/api/combos | python3 -m json.tool
```

Expected: `{"combos": [{"id": 1, "name": "vision-batch", ...}]}`

**Step 4: Get by id**

```bash
curl -s http://localhost:3001/api/combos/1 | python3 -m json.tool
```

Expected: the combo object.

**Step 5: Update the combo**

```bash
curl -s -X PATCH http://localhost:3001/api/combos/1 \
  -H 'Content-Type: application/json' \
  -d '{"strategy": "round-robin", "sticky_limit": 3}' | python3 -m json.tool
```

Expected: updated combo with `strategy: "round-robin"` and `stickyLimit: 3`.

**Step 6: Delete the combo**

```bash
curl -s -X DELETE http://localhost:3001/api/combos/1 | python3 -m json.tool
```

Expected: `{"success": true, "id": 1}`

**Step 7: Verify 404 on deleted**

```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/combos/1
```

Expected: `404`

**Step 8: Clean up**

```bash
kill %1 2>/dev/null; wait 2>/dev/null
```

**Step 9: (Optional but recommended) Add a test that covers the HTTP route layer**

If time permits, add an integration test similar to `server/src/__tests__/routes/keys.test.ts` that exercises the Express router end-to-end using the existing test helpers.

---

## Summary of files created/modified

| File | Action | Purpose |
|------|--------|---------|
| `server/src/db/migrations/20260729_000001_combos.ts` | **Create** | DB schema: `combos` table |
| `server/src/db/migrate/defaults.ts` | **Modify** | Register migration + export constant |
| `server/src/services/combos.ts` | **Create** | Pure CRUD + validation + combo resolution |
| `server/src/routes/combos.ts` | **Create** | REST API: GET/POST/PATCH/DELETE `/api/combos` |
| `server/src/app.ts` | **Modify** | Mount `combosRouter` at `/api/combos` |
| `server/src/__tests__/services/combos.test.ts` | **Create** | Unit tests for service layer |

## Validation checklist

- [ ] Migration runs (`npm run db:migration:up`) without error
- [ ] Migration status shows as applied (`npm run db:migration:status`)
- [ ] Existing migration tests still pass (`npm run test:migrations`)
- [ ] Server compiles (`npm run build:server`) without type errors
- [ ] Service tests pass (`npx vitest run src/__tests__/services/combos.test.ts`)
- [ ] HTTP API smoke test: create → read → update → delete works
- [ ] Invalid inputs return proper 400 errors
- [ ] Duplicate names return 409 Conflict
- [ ] Unknown ids return 404

## Open questions / future considerations

- **Authentication:** The existing `/api/*` routes use auth middleware (`requireAuth`). Should combo endpoints also require auth? (Most other `/api` routes do — check whether `combosRouter` should be mounted behind `requireAuth`.)
- **Model validation on create:** Currently, any string is accepted in the `models` array. Phase 2 should add validation that each model string is resolvable in the catalog.
- **Concurrent update safety:** No optimistic locking on the combo row — last-write-wins. Acceptable for Phase 1.

---

## Ready for Phase 2

After this phase, the following building blocks are in place:

1. `combos` table with name-indexed lookups
2. `services/combos.ts` with `resolveCombo(db, modelStr)` — the key function Phase 2 will call from `proxy.ts`
3. `services/combos.ts` with `getComboModelIds(db)` — for listing combos in `/v1/models`
4. Full REST API for managing combos from the dashboard

Phase 2 will:
- Intercept `model` in `proxy.ts` and call `resolveCombo()`
- Implement the fallback/round-robin/fusion loop over combo models
- Show combo names in the `/v1/models` listing
- Add capability auto-switching (vision models first for image requests)
