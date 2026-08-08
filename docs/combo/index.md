# Combos — Named Model Groups

Combos let you group multiple models under a single name and use that name
directly in the `model` field of `/v1/chat/completions`. The gateway resolves
the name at request time and routes according to the configured strategy.

## Quick Start

```bash
# Create a fallback combo (try model A, if it fails try model B)
curl -X POST http://localhost:3001/api/combos \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-fallback",
    "models": ["gpt-4o", "claude-sonnet-4"],
    "strategy": "fallback"
  }'

# Use it like any model name
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-fallback",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Strategies

### `fallback` (default)

Try each model in order. If the first model fails (provider down, rate limited,
insufficient quota), the gateway automatically retries the next model in the
list.

```
Request → model[0] → (fail) → model[1] → (fail) → model[2] → response
         └── success ──┘       └── success ──┘       └── (all fail → 503)
```

This is the same mechanism as the system-level fallback chain, but scoped to
only the models in the combo.

### `round-robin`

Rotate between models on each request. Each request picks the next model in
sequence, wrapping around at the end. The `stickyLimit` parameter controls how
many consecutive requests stay on the same model before rotating.

```
Request 1 → model[0]        (sticky_count=1)
Request 2 → model[0]        (sticky_count=2 ≤ stickyLimit=3)
Request 3 → model[0]        (sticky_count=3 ≤ stickyLimit=3)
Request 4 → model[1]        (sticky_count=1 — rotated)
```

Stickiness keeps the warm cache / connection pool hot for repeated calls while
still distributing load over time.

Use this for:
- **Load balancing** across multiple providers for the same model capability
- **A/B testing** responses from different providers
- **Cache warming** — stickiness keeps the last-used provider warm

### `fusion` (advanced)

Sends the request to ALL models in the combo simultaneously and aggregates
their responses.

> **Note:** Fusion is handled by a separate service (`services/fusion.ts`).
> Combos with `strategy: "fusion"` are passed through to the same fusion
> engine that handles the `"fusion"` model id — the combo acts as an alias
> for the model list.

## Behaviour

### Model visibility

Combo names appear as virtual model entries in `GET /v1/models`. They have
`available: true` and `enabled: true` regardless of the underlying model
status. This lets any client (including auto-router) discover and select them.

```json
{
  "id": "my-fallback",
  "name": "Combo: my-fallback",
  "owned_by": "freellmapi",
  "available": true,
  "context_window": 200000
}
```

### Capability auto-switch (vision)

When a request contains image content and the combo has multiple models,
vision-capable models are prioritised ahead of non-vision models in the
fallback order. This prevents routing an image-based request to a model
that can't process it.

### Skip / bypass

If the combo name doesn't exist, normal model resolution runs. The string
`"auto"` and the special keyword `"fusion"` are never treated as combo names
and always follow their own dedicated paths.

## CRUD API

All endpoints are under `/api/combos`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/combos` | List all combos |
| `POST` | `/api/combos` | Create a new combo |
| `GET` | `/api/combos/:id` | Get a single combo |
| `PATCH` | `/api/combos/:id` | Update a combo |
| `DELETE` | `/api/combos/:id` | Delete a combo |

### Request body (create / update)

```json
{
  "name": "my-combo",
  "description": "Optional description",
  "models": ["model-id-1", "model-id-2"],
  "strategy": "fallback | round-robin | fusion",
  "stickyLimit": 1,
  "kind": "chat"
}
```

- **models**: Array of model_id strings (from the catalog). At least one must
  be enabled at request time.
- **strategy**: `"fallback"` (default), `"round-robin"`, or `"fusion"`.
- **stickyLimit**: Only meaningful for `round-robin`. Default `1` — rotate
  every request. Higher values keep the same model for N consecutive requests.

### Schema

```
Table: combos
  id            INTEGER PRIMARY KEY AUTOINCREMENT
  name          TEXT UNIQUE NOT NULL
  description   TEXT NOT NULL DEFAULT ''
  models        TEXT NOT NULL  -- JSON array of model_id strings
  strategy      TEXT NOT NULL DEFAULT 'fallback'  -- fallback | round-robin | fusion
  stickyLimit   INTEGER NOT NULL DEFAULT 1
  judgeModel    TEXT            -- optional fusion judge
  kind          TEXT NOT NULL DEFAULT 'chat'
  createdAt     TEXT NOT NULL
  updatedAt     TEXT NOT NULL
```

## Architecture

```
Client → /v1/chat/completions
          │
          ├─ model = "auto"      → auto-routing (sticky model)
          ├─ model = "fusion"    → fusion service
          ├─ model = "<combo>"   → resolve combo → parse strategy
          │                        ├─ fallback    → build chain → fallback loop
          │                        ├─ round-robin → pick one model → single request
          │                        └─ fusion      → fusion service (with combo models)
          └─ model = "<id>"      → normal model resolution / unify
```

## Files

| File | Purpose |
|------|---------|
| `src/services/combos.ts` | CRUD service + Zod validation + `resolveCombo()` / `getComboModelIds()` |
| `src/routes/combos.ts` | Express router for `/api/combos` |
| `src/routes/proxy.ts` | `/v1/chat/completions` — combo interception at model resolution |
| `src/services/round-robin.ts` | In-memory round-robin state tracker |
| `src/services/model-listing.ts` | Appends combo names to `/v1/models` |
| `src/__tests__/services/combos.test.ts` | Unit tests for CRUD service |
| `src/__tests__/services/round-robin.test.ts` | Unit tests for round-robin tracker |
| `src/__tests__/routes/combos-routing.test.ts` | Integration tests for routing paths |
