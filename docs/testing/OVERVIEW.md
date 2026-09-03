# Testing overview

## Scope

This domain documents how FreeLLMAPI is tested: the local command matrix across the monorepo workspaces, the layout and conventions of the server suite (serial forked execution, module-purity guard, loopback binding), and the end-to-end coding-agent compatibility suite introduced in #629.

Sources: the root [`package.json`](../../package.json) test chain, per-workspace `package.json` scripts ([server](../../server/package.json), [client](../../client/package.json)), [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), and the suites themselves under [`server/src/__tests__/`](../../server/src/__tests__).

## File index

| File | Description |
| --- | --- |
| [01-running-tests.md](01-running-tests.md) | The full local matrix — root chain order, per-workspace commands, the migration roundtrip check — and a summary of what CI runs on ubuntu-24.04. |
| [02-server-suite.md](02-server-suite.md) | `src/__tests__/` directory layout, why vitest runs with `--pool=forks --fileParallelism=false`, the pure-lib import guard (#858), and the bind-to-loopback convention (#888). |
| [03-compatibility-suite.md](03-compatibility-suite.md) | The e2e coding-agent compatibility suite from #629: what it covers, where it lives, and what it proves. |

## Conventions

- One entry point: `npm test` at the repo root runs bootstrap and hook checks, then server, cli, and client workspaces in order.
- Server tests are deterministic and side-effect aware: no live provider calls, servers bound to `127.0.0.1`, shared state isolated by running files serially in forked pools.
- CI is the same matrix on both ends of the supported Node range (20 and 22) — if it passes locally with `npm test && npm run build`, CI should agree.
