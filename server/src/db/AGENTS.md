# db — SQLite schema, migrations, model seeding

**Relevant for:** schema changes, adding/updating provider model catalogs  
**Depends on:** `lib/crypto.ts` (key encryption), `shared/types.ts` (type defs)

---

## Files

```
db/
└── index.ts  # 1286 lines — initDb(), getDb(), migrateModelsV0–V14, seedModels()
```

Single-file module. No barrel, no ORM wrapper re-export — `getDb()` is imported directly.

---

## Key patterns

- **`initDb()`**: called once at startup (`server/src/index.ts`). Opens/creates SQLite db, runs all migrations in sequence, seeds default models if the `models` table is empty.
- **14 sequential migrations** (`migrateModelsV0` → `V14`): each is a standalone function that applies a schema change. Never renumbered or modified after creation — always append.
- **better-sqlite3** (synchronous): all DB operations are synchronous. No async/await for DB calls.
- **drizzle-orm** for query building in routes/services. Direct `db.prepare()` only in tests and migration functions.
- **Model seeding**: `seedModels()` upserts the default provider catalog. Re-run via scripts in `server/src/scripts/` when upstream catalogs change.

---

## Conventions (this directory only)

- **Migration naming**: `migrateModelsV{N}` where `N` increments. The integer is checked against `schema_version` in the DB — only unapplied migrations run.
- **Raw DDL** is acceptable here (CREATE TABLE, ALTER TABLE, CREATE INDEX). Everywhere else, use drizzle helpers.
- **Key column**: `api_keys.key` stores AES-256-GCM encrypted ciphertext (hex), never plaintext.

---

## Pitfalls

- **`npm rebuild better-sqlite3` required** after Node version changes — native module, NODE_MODULE_VERSION mismatch causes crash at `require()`.
- **`ENCRYPTION_KEY` required** at startup (64-char hex). `DEV_MODE=true` fallback exists but logs a loud warning — never use with real API keys.
- **Seeding is idempotent by INSERT OR IGNORE** — re-running `seedModels()` won't overwrite custom changes, but also won't update existing model specs if the provider changed them upstream.
- **`:memory:` for tests** — `initDb(':memory:')` creates an in-memory DB. Works because better-sqlite3 handles it transparently, but note that schema-level migrations run every time (fast enough).
