# Database Migrations

Schema changes belong in migration files under `src/db/migrations/`.
Create them with:

```sh
npm run db:migration:create --name=add_embedding_index
```

In local development, run pending migrations manually with:

```sh
npm run db:migration:up
```

Production startup applies pending migrations automatically. Tests auto-run
migrations from `initDb()` so each test DB starts with the full schema.

Use `db:migration:fresh` only for local development or tests. It drops app
tables, then runs all migrations so the DB is immediately usable:

```sh
npm run db:migration:fresh
```

Never run `db:migration:fresh` in production.

Built-in model data (models, limits, ranks) lives in the signed hosted catalog,
not in migrations. The legacy baseline migration seeds the original rows
(`source = 'catalog'`), but V25 was the last model-data migration: catalog-sync
now owns those rows and adds, updates, or prunes them on every apply. Shipping
model data as a migration would hand it to free users on their next binary
update and bypass the Premium-now / Free-after-30-days gate. To add, retire, or
correct a built-in model, change the published catalog. Use migrations only for
schema, family rules, provider plumbing, and quirk-seed corrections.

Use `db:migration:status` to inspect which migration files have already run.
