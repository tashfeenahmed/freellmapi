# Plan: find (and tame) every implicit state machine

Date: 2026-11-11 · Status: draft, not started · Scope: `server/`, `client/`, `desktop/`, `cli/`, `shared/`

## 1. Goal

Find every place where the app tracks "what phase is this thing in" without saying so: boolean
flag clusters, nullable fields whose presence means a phase, module-level `let`s mutated from
several functions, timers and retry counters, DB columns that encode a lifecycle. Then, for each
one, make the best call for all three audiences at once:

- **UX**: no impossible UI (spinner and error at once, stuck "busy", lost cancel/retry), clear
  loading / error / empty / retry states on every async flow.
- **DX**: one obvious place to read the states and legal transitions; the compiler rejects an
  unhandled state; new contributors don't have to reverse-engineer flags.
- **AX** (agents): a single registry an agent can read to answer "what states can X be in, who
  moves it, where is it tested", with greppable names that match the code.

**Hard constraint: break nothing.** No change to wire formats (API JSON, SSE frames, OpenAPI
spec), stored DB values, i18n keys, CLI output, or hot-path latency.

## 2. The decision (and why)

**Use the pattern this repo already has. Add no state-machine library.**

`desktop/src/updater.ts` is already an explicit machine: a discriminated union
(`{ phase: 'idle' } | { phase: 'checking' } | { phase: 'downloading'; percent } | …`), one
`setState`, and guards like `if (state.phase !== 'available') return`. `client/src/lib/docker-update.ts`
(`DockerUpdatePhase`), `server/src/lib/think-tags.ts` (`FilterState`),
`server/src/services/degradation.ts` (`DegradationState`) and
`client/src/components/playground/dictation-button.tsx` (`DictationPhase`) follow the same idea.

Why this beats XState / other machine libraries for UX + DX + AX together:

| Option | UX | DX | AX | Risk |
| --- | --- | --- | --- | --- |
| Discriminated union + pure `transition()` (house pattern) | Impossible states unrepresentable | Plain TS, exhaustive `switch`, zero new concepts | Greppable, types are the docs | Lowest; no new dep |
| XState | Same | Learning curve, visualizer | Agents must know XState API; actor indirection | New dep, big diffs |
| Leave as is, document only | No gain | Docs drift | Partial | None, but no fix |

Rule: **not every boolean is a machine.** Make a machine explicit only when it pays (see §6).
TanStack Query already owns server-state fetching on the client: `isPending/isError` from a query
is *not* a custom machine and must not be duplicated.

Already documented machines (link from the registry, don't duplicate):
- Degraded mode: `docs/en/architecture/04-degraded-mode-and-failover.md` §1.
- Per-attempt streaming: `docs/en/architecture/03-streaming-pipeline.md` ("State machine per attempt").

## 3. What counts as a signal (detection heuristics)

Every sweep agent searches for these signals and records each hit with `file:line`:

| ID | Signal | Example already seen |
| --- | --- | --- |
| S1 | String-union type named `*Status/State/Phase/Stage/Mode/Step` | `KeyStatus`, `DegradationState`, `CheckStatus` (28 found) |
| S2 | ≥3 boolean/flag `useState`s in one component scope | `auth-gate.tsx`: `busy`, `error`, `attempted`, `codeRequired`, `showForgot` |
| S3 | Module-level `let` written from >1 function | `lib/proxy.ts` (12), `lib/server-logs.ts` (9), `services/router.ts` (8) |
| S4 | Timers, `AbortController`, retry/attempt counters, backoff levels | `fallback-loop.ts`, `ratelimit.ts` cooldown 2m→10m→1h→24h |
| S5 | Persisted lifecycle: `status`/`enabled` columns, `*_until`/`*_at` timestamps, tombstones | `enabled` (8 tables), catalog retirement / tombstone / override |
| S6 | Compound guards: `if (a && !b && c)` deciding behavior | — |
| S7 | Nullable fields whose null-ness encodes phase (`error: string \| null`, `startedAt?`) | — |
| S8 | Event handlers that `setState` (`.on('…')`, `onmessage`, SSE parsers) | `desktop/src/updater.ts`, `playground-stream.ts` |
| S9 | Step/wizard indices (`step`, `ForgotStep`, `stage`) | `auth-gate.tsx` `ForgotStep` |
| S10 | Same union declared twice (drift risk) | `OllamaEmulationMode` (server) vs `OllamaMode` (client) |
| S11 | Status mapping tables (HTTP code → next state) | `lib/error-classify.ts` |

Classify every hit as one of: **lifecycle** (entity over time), **workflow** (multi-step user/flow),
**protocol** (stream/parser), **mode** (static config switch, usually *not* a machine), or
**derived** (computed from others, not stored state, not a machine).

## 4. Seed inventory (from a first grep pass, to be verified in Phase 1)

Server
- Cooldown / rate-limit escalation per `(model, key)`: `services/ratelimit.ts`, `services/cooldown-probe.ts`
  (heuristic vs authoritative vs credit vs tier; probe eligibility).
- Key health: `KeyStatus` in `shared/types.ts`, `services/health.ts`, `services/provider-credential.ts`.
- Provider health: `ProviderHealthStatus` (shared).
- Degraded mode: `services/degradation.ts` (explicit, documented in 04).
- Catalog model lifecycle: model-age gate premium → free, tombstone, override, retirement, reinstate
  (`services/model-state.ts`, `model-retirement.ts`, `custom-model-tombstone.ts`, `catalog-sync.ts`).
- Catalog sync run: `services/catalog-sync.ts` (module `let`s).
- Request attempt lifecycle: `lib/fallback-loop.ts`, `lib/ttfb-budget.ts`, `lib/provider-timeout.ts`.
- Streaming: per-attempt machine (documented in 03), `lib/think-tags.ts` (explicit), `lib/tool-call-rescue.ts`.
- Idempotency: `services/idempotency.ts` (in-flight / done / expired).
- Async media jobs: `providers/sail.ts` (`SailStatus`), `services/media.ts`.
- Multi-pass generation: `services/fusion.ts`, `services/iterative-critique.ts` (**uncommitted work, see §9**).
- Auth: first-run setup, one-time code, reset code (`lib/setup-code.ts`, `lib/one-time-code.ts`, `lib/reset-code.ts`, `routes/auth.ts`).
- Update check: `routes/update.ts` (`CheckStatus`, 7 values).
- Process lifecycle: `lib/scheduler.ts`, `lib/graceful-shutdown.ts`, `lib/wake-detect.ts`, `lib/process-safety-net.ts`.
- Mutable singletons: `lib/proxy.ts`, `lib/server-logs.ts`, `services/router.ts`, `services/cache.ts`, `services/request-retention.ts`.
- Already explicit (reference only): `db/migrate/runner.ts` (`MigrationState`).

Client (useState count in brackets)
- `components/auth-gate.tsx` [20]: login, setup code, forgot/reset (`ForgotStep`), change credentials, repair.
- `pages/PlaygroundPage.tsx` [18] + `lib/playground-stream.ts`, `lib/playground-conversations.ts`, artifact panel, dictation.
- `components/keys/provider-list.tsx` [13], `add-model-dialog.tsx` [12], `custom-provider-section.tsx` [11],
  `backups-section.tsx` [8], `edit-key-dialog.tsx` [7], `add-key-form.tsx` [7], `export-keys-dialog.tsx` [6].
- `pages/LogsPage.tsx` [10], `components/settings-dialog.tsx` [10], `pages/FusionPage.tsx` [8],
  `pages/FallbackPage.tsx` [7], `components/chain-manager.tsx` [7].
- Updates: `components/updates-dialog.tsx`, `update-reminder.tsx`, `lib/docker-update.ts` (explicit), `lib/desktop-updater.ts`.
- Toasts: `lib/toast.ts`, `lib/toast-timer.ts`.

Desktop
- `src/updater.ts` (explicit, **the reference implementation**), `src/server-host.ts` (child server
  start / ready / crash / restart), `src/window.ts`, `src/tray-visibility.ts`, `src/main.ts` timers.

CLI
- `src/doctor.ts`, `src/tools.ts` + `src/config-files.ts` (detect → plan → apply → verify flow).

## 5. Phases

Model rule: **Haiku 5.5 for mechanical work, Sonnet 5.5 for reasoning; the main session only
merges, decides, and reviews.** Agents in one phase run in parallel in a single message. Keep each
wave under 10 agents.

### Phase 0 — Baseline (main session, no agents)

1. Confirm the tree is green: `npm test`, `npm run lint`, `npm run build`, `cd client && npm run check:i18n`.
2. Record metrics to compare later: per-file `useState` counts, module-level `let` counts, count of
   S1 unions (commands in Appendix A).
3. List files with uncommitted changes and mark them **read-only** for the whole effort (§9).
4. Create a scratch folder for agent outputs outside the repo (session scratchpad).

### Phase 1 — Discovery sweep (6 × Haiku 5.5, read-only, parallel)

Agent type: `Explore` (or `caveman:cavecrew-investigator`) with `model: "haiku"`.
One agent per slice so no two read the same files:

| Agent | Slice |
| --- | --- |
| H1 | `server/src/services/**` |
| H2 | `server/src/lib/**`, `server/src/middleware/**` |
| H3 | `server/src/routes/**`, `server/src/providers/**` |
| H4 | `server/src/db/**` (persisted lifecycles: S5 only; read migrations + `db/types.ts`) |
| H5 | `client/src/pages/**`, `client/src/hooks/**`, `client/src/lib/**` |
| H6 | `client/src/components/**`, `desktop/src/**`, `cli/src/**`, `shared/**` |

Brief core (same for each): "Search your slice for signals S1–S11 (table attached). For each hit,
return one JSON row: `{id, file, line, signal, name, states_seen[], mutated_at[file:line],
persisted: memory|db|localStorage|file, class: lifecycle|workflow|protocol|mode|derived}`.
Do not judge or suggest fixes. Skip `*.test.*` and `__tests__`. Return rows only."

Exit: one merged list. Expect 60–120 raw rows.

### Phase 2 — Consolidate (main session)

1. Dedupe rows that describe the same machine from different files (e.g. key status touched in
   `health.ts`, `ratelimit.ts`, `routes/keys.ts`, `provider-list.tsx`).
2. Move `mode` and `derived` rows to an "excluded, with reason" list (keeps the registry honest).
3. Group survivors into **machine candidates**, each with one owner file. Expect 25–40.
4. Flag S10 duplicates (server/client copies of one union) as quick DX wins: the client imports
   from `@freellmapi/shared` instead.

### Phase 3 — Deep analysis (≈8 × Sonnet 5.5, read-only, parallel)

Agent type: `ecc:code-explorer` (or `Explore`) with `model: "sonnet"`. One agent per cluster:

1. Quota / cooldown / key health
2. Catalog model lifecycle + sync
3. Request attempt + streaming + idempotency
4. Auth + setup/reset codes (server + `auth-gate.tsx`)
5. Playground + stream + conversations
6. Keys / providers dialogs
7. Updates (server route, client, desktop, docker) + desktop `server-host.ts`
8. Process lifecycle + mutable singletons + CLI flows

Each agent returns, per machine:

- **State table**: states, events, transitions, guards, side effects (timers, IO, DB writes).
- **Mermaid `stateDiagram-v2`** of the *actual* behavior, not the intended one.
- **Mutation sites**: every `file:line` that changes the state.
- **Illegal states**: flag combinations the code can reach but no state should allow, with the
  exact steps that reach them (e.g. `busy=true` stays set after an exception path skips the reset).
- **Missing states** that hurt UX: no error, no cancel, no retry, no empty, no timeout.
- **Tests today**: which test files cover which transitions; uncovered transitions.
- **Bug history**: `git log --oneline -- <file> | grep -iE "fix|stuck|race|hang"` count.

### Phase 4 — Adversarial verify (≈4 × Sonnet 5.5, read-only)

Only for claims of reachable illegal states or races, because those claims drive refactors.
Give the verifier the code paths, **not** the Phase 3 conclusion. It must either produce
reproduction steps / a failing-test sketch, or refute the claim. Unverified claims drop to
"document only".

### Phase 5 — Score and decide (main session)

Score each machine 0–3 on each axis:

| Axis | 3 means |
| --- | --- |
| UX | Users can see a wrong/stuck state today, or an async flow lacks error/cancel/retry |
| DX | ≥3 mutation sites or ≥4 coupled flags; fix history in git log |
| AX | Agents edit this area often (router, ratelimit, catalog, Playground) and its states are undocumented |
| Risk (subtract) | Hot path (router/ratelimit/fallback-loop), persisted values, or wide blast radius |

Actions, cheapest first:

1. **Exclude**: mode or derived value. Listed with reason.
2. **Document only**: add to the registry (§Phase 8). Default for low scores and for hot paths without a verified bug.
3. **Types only**: replace flags with one discriminated union; no logic moves. The compiler now
   rejects impossible states.
4. **Extract transition**: pure `transition(state, event)` function + table-driven unit test;
   callers dispatch events.
5. **Full refactor**: only with a verified UX bug or ≥3 fix commits.

Hot-path machines (router, ratelimit, fallback-loop, streaming) stay at action 2 or 3 unless
Phase 4 verified a bug. Any change there needs a before/after timing check.

### Phase 6 — Tiny foundation (1 PR)

- Add `assertNever(x: never): never` to `shared/types.ts` (the one shared module) for exhaustive `switch`.
- Evaluate `@typescript-eslint/switch-exhaustiveness-check` (already installed via
  `typescript-eslint`). It needs type-aware linting. Adopt it only if `npm run lint` time stays
  acceptable; otherwise rely on `assertNever`.
- Add a **State machine** entry to `GLOSSARY.md` pointing at the registry.

### Phase 7 — Refactors (one machine per PR, ordered by score)

Per CONTRIBUTING: one scoped change per PR, with a test. Implementer: `ecc:tdd-guide` or
`general-purpose` with `model: "sonnet"`, `isolation: "worktree"`. Reviewer: `ecc:typescript-reviewer`
(server/desktop/cli) or `ecc:react-reviewer` (client) with `model: "sonnet"`. Doc/diagram updates:
Haiku. The main session reviews every diff before it is offered for merge.

Per-PR recipe (do not skip a step):

1. **Characterization tests first**: pin today's observable behavior (responses, DB rows, rendered
   UI, SSE frames) for every transition in the Phase 3 table. They must pass *before* the change.
2. Introduce the union type (action 3) and, if chosen, the pure `transition()` (action 4).
3. Route every mutation site through it. No site sets the state directly afterwards.
4. Map at the boundary: stored DB values, API JSON and i18n keys stay byte-identical.
5. Add the transition-table test: every legal edge; illegal events are no-ops or throw, as decided.
6. Gates: `npm test`, `npm run lint`, `npm run build`, `check:i18n`; OpenAPI spec unchanged; client
   snapshots unchanged unless the PR is a deliberate UX fix (then called out in the PR).
7. Update the machine's registry entry and diagram in the same PR.

Server template (illustrative):

```ts
export type SyncState =
  | { phase: 'idle'; lastOkAt?: string }
  | { phase: 'running'; startedAt: string }
  | { phase: 'failed'; at: string; message: string };

export type SyncEvent =
  | { type: 'start'; at: string }
  | { type: 'ok'; at: string }
  | { type: 'fail'; at: string; message: string };

export function transition(s: SyncState, e: SyncEvent): SyncState {
  switch (e.type) {
    case 'start': return s.phase === 'running' ? s : { phase: 'running', startedAt: e.at };
    case 'ok':    return s.phase === 'running' ? { phase: 'idle', lastOkAt: e.at } : s;
    case 'fail':  return s.phase === 'running' ? { phase: 'failed', at: e.at, message: e.message } : s;
    default:      return assertNever(e);
  }
}
```

Client template: the same union + `useReducer(transition, initial)`. Form inputs (email, password)
stay plain `useState`; only the *phase* (`editing | submitting | needsCode | error | done`) moves
into the reducer. Every phase renders exactly one affordance set (spinner, error + retry, success).

Likely first PRs (to be confirmed by Phase 5 scores):

1. S10 duplicate unions → import from shared (pure DX/AX win, near-zero risk).
2. `auth-gate.tsx` login / forgot / change-credentials phases (20 `useState`, user-facing).
3. Playground send / stream / cancel phase (`PlaygroundPage.tsx` + `playground-stream.ts`).
4. Keys dialogs: shared `submitting | error | done` phase for add / edit / export / copy.
5. Desktop `server-host.ts` lifecycle (crash/restart visibility in the tray).
6. Catalog model lifecycle: **document + types only** (persisted, many readers).
7. Cooldown escalation: **document only** unless Phase 4 verifies a bug.

### Phase 8 — Registry and agent experience

- New doc `docs/en/architecture/07-state-machines.md`, following the docs layout
  (`docs/<lang>/<domain>/NN-topic.md`). Update `docs/en/architecture/OVERVIEW.md`,
  `00-high-level-index.md`, and `CHANGELOG.md`. zh-cn mirror per `docs/TRANSLATION.md` as a follow-up.
- Machines already covered in 03 and 04 get a short entry that links there.
- One section per machine, same shape every time so agents can parse it:

  ````md
  ### <Machine name>
  - Owner: `path/to/file.ts` (type `XState`, function `transition`)
  - Class: lifecycle | workflow | protocol
  - Persisted: memory | db (`table.column`) | localStorage key
  - States: a, b, c
  - Mutated only via: `file:line` …
  - Tests: `path/to/test.ts`
  - Status: explicit | types-only | documented-only

  ```mermaid
  stateDiagram-v2
    [*] --> a
    a --> b: event
  ```
  ````
- An "excluded: modes and derived values, not machines" list at the end, so agents don't re-flag them.
- Optional, only if drift shows up: a small test that checks each explicit machine's exported
  transition list against its registry diagram.

## 6. "Make it explicit only when it pays"

Do it when at least one holds:
- A verified illegal or stuck state is reachable (Phase 4).
- ≥3 mutation sites, or ≥4 coupled flags in one scope.
- A user-visible async flow lacks error, cancel, retry, or timeout handling.
- ≥3 bug-fix commits on the file mention stuck / race / hang / state.

Otherwise document it and move on.

## 7. Deliverables

1. Inventory (Phase 2) and analysis (Phases 3–4) in the session scratchpad; the durable result is the registry.
2. `docs/en/architecture/07-state-machines.md`: every machine with diagram, owner, tests, status, plus the excluded list.
3. `GLOSSARY.md` entry; `assertNever` in `shared/types.ts`.
4. One PR per refactored machine, each with characterization + transition tests.
5. A short before/after metrics note (Appendix A) in the final PR.

## 8. Success criteria

- Every Phase 1 candidate is in the registry or in the excluded list with a reason. No silent drops.
- Refactored machines: zero reachable illegal states; every `switch` on the state is exhaustive at compile time.
- No change in API JSON, SSE frames, OpenAPI spec, DB values, or i18n keys; full suite green on every PR.
- Hot-path timing unchanged within noise for any touched router / ratelimit / fallback code.
- An agent given only `GLOSSARY.md` + the registry can answer "what states can X be in, who changes
  it, which test covers it" for any listed machine.

## 9. Risks and guards

| Risk | Guard |
| --- | --- |
| Uncommitted work at plan time: `client/src/App.tsx`, `components/command-palette.tsx`, `components/models-tabs.tsx`, `i18n/locales/en.json`, `pages/PlaygroundPage.tsx`, `server/src/routes/proxy.ts`, `services/fusion.ts`, new `services/iterative-critique.ts` and `pages/IterativeCritiquePage.tsx` | Read-only for discovery. No refactor PR touches them until that work is committed. |
| Regressions in the hot path | Document-only default; before/after timing; characterization tests. |
| Persisted values change meaning | Never change stored strings or columns; map at the boundary. Never edit applied migrations; any schema change is a new migration. |
| Over-engineering | §6 rule; modes and derived values excluded; no new dependency. |
| Agent false positives | Phase 4 adversarial verify with code, not conclusions. |
| Scope creep | One machine per PR; everything else waits in the registry. |
| i18n breakage | Keys unchanged; `check:i18n` gate on every client PR. |

## 10. Agent budget

| Phase | Agents | Model | Type |
| --- | --- | --- | --- |
| 1 Discovery | 6 | Haiku 5.5 | `Explore` / `caveman:cavecrew-investigator` |
| 3 Deep analysis | ~8 | Sonnet 5.5 | `ecc:code-explorer` |
| 4 Verify | ~4 | Sonnet 5.5 | `general-purpose` (read-only brief) |
| 7 Implement | 1 per PR | Sonnet 5.5 | `ecc:tdd-guide`, worktree |
| 7 Review | 1 per PR | Sonnet 5.5 | `ecc:typescript-reviewer` / `ecc:react-reviewer` |
| 8 Docs / diagrams | 1–2 | Haiku 5.5 | `general-purpose` |

Phases 1–5 change no code and fit in one session. Each Phase 7 PR can run in its own
session / worktree once Phase 5 has ordered them.

## Appendix A — baseline metric commands

```bash
# useState per client file
grep -rcE "useState[<(]" --include=*.tsx --include=*.ts client/src | grep -vE "\.test\.|:0$" | sort -t: -k2 -nr
# module-level let per server/desktop/cli file
grep -rcE "^let \w+" --include=*.ts server/src desktop/src cli/src | grep -vE "\.test\.|__tests__|:0$" | sort -t: -k2 -nr
# string-union phase/status types
grep -rnE "type \w*(Status|State|Phase|Stage|Mode|Step)\w* *= *['\"]" --include=*.ts --include=*.tsx server/src client/src cli/src desktop/src shared | grep -v "\.test\."
```

Baseline at plan time: 28 status/phase unions; top `useState` files `auth-gate.tsx` 20,
`PlaygroundPage.tsx` 18, `provider-list.tsx` 13; top module-level `let` files `lib/proxy.ts` 12,
`lib/server-logs.ts` 9, `services/router.ts` 8, `desktop/src/updater.ts` 8.
