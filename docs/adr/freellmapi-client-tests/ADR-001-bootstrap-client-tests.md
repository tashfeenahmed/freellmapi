# ADR-001: Bootstrap Client-Side Test Harness

- Status: Accepted
- Date: 2026-07-13 (Week 28)
- Deciders: code profile (Hermes)
- Related: t_d98f3679 (P1 freellmapi client test bootstrap)

## Context

The freellmapi monorepo (`~/freellmapi`) ships a server-side vitest suite
(~20 files) but the **client had zero tests** — there was no test script in
`client/package.json`, no vitest config, and no React Testing Library setup.
The dashboard is the primary user surface (key management, model catalog,
playground), so a regression there ships straight to users. We needed a
minimal, reliable harness to start catching client regressions without
attempting full coverage.

## Decision

Bootstrap a vitest + React Testing Library (RTL) + jsdom harness in `client/`:

- `client/vitest.config.ts` — vitest with `environment: 'jsdom'`, the `@`
  path alias (mirrors `vite.config.ts`), and `vitest.setup.ts` as setup file.
- `client/vitest.setup.ts` — loads `@testing-library/jest-dom/vitest` matchers
  and polyfills two jsdom gaps that the app touches on mount:
  - an in-memory `window.localStorage` (jsdom v26 does not always expose a
    functional one; i18n + auth read/write it), and
  - a permissive `window.matchMedia` stub (App reads it for dark-mode pref).
  - `afterEach` cleanup + `vi.restoreAllMocks()`.
- `client/package.json` — added `"test": "vitest run"` and devDeps:
  `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`,
  `@testing-library/user-event`.
- `client/src/vitest.d.ts` — references `vitest/globals` + jest-dom types so
  `tsc -b` type-checks the tests (matchers + global `vi`).
- `client/tsconfig.app.json` — added `vitest/globals` + `@testing-library/jest-dom`
  to `compilerOptions.types`.

### Smoke tests shipped (scope: harness + smoke, not full coverage)

1. `src/lib/model-list.test.ts` — unit tests for `parseModelList`, the
   model-selector parser used by the custom-provider form. This helper was
   **extracted** from `KeysPage.tsx` into `src/lib/model-list.ts` so it can be
   tested in isolation (also a small code-quality win).
2. `src/App.test.tsx` — dashboard render smoke: `App` mounts (with
   `apiFetch` mocked) and renders the brand + primary navigation without
   throwing.
3. `src/pages/KeysPage.test.tsx` — key-list smoke: `KeysPage` mounts, fetches
   keys via the mocked `apiFetch`, and renders provider rows.

### Mocking strategy

A shared helper `src/test/api-mock.ts` exports `installApiFetchMock()`, which
spies on `@/lib/api`'s `apiFetch` and routes by path to canned data
(`/api/auth/status`, `/api/keys`, …). This lets render tests run with **no
live backend** — deterministic and fast. The root `npm test` already chains
`npm run test -w server && npm run test -w client --if-present`, so the client
suite now runs in CI alongside the server suite.

## Consequences

- **Positive:** client regressions are now caught by `npm run test -w client`;
  CI can run the dashboard suite; `parseModelList` is independently tested.
- **Negative / follow-up:** only 3 smoke-level files (8 tests) — full coverage
  of components remains future work. The server suite currently fails to
  *initialize* because `better-sqlite3`'s native module is not built for the
  local Node 25 runtime (pre-existing, unrelated to this change).

## Validation

- `npx vitest run` (client): **8 passed / 8** across 3 files.
- `npx tsc -b` (client): clean.
- `npx vite build` (client): succeeds.
