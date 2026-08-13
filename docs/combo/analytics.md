# Combo Visibility — Analytics & Playground Integration (Phase 4)

**Goal:** Surface combo information in existing surfaces (Analytics Recent Calls, Playground model picker) and add a dedicated Combo Analytics dashboard section with per-combo summary cards, model distribution bars, and fallback depth visualization.

## Tasks

| Task | Status | Description |
|------|--------|-------------|
| 1 — `requested_model` filter | ✅ | Server: `GET /api/analytics/requests?requested_model=<name>` |
| 2 — Type column + filter | ✅ | Frontend: Recent Calls table shows Type column + combo filter dropdown |
| 3 — Playground dropdown | ✅ | Combo names in model picker with strategy badges |
| 4 — `/by-combo` endpoint | ✅ | Server: `GET /api/analytics/by-combo?range=30d` |
| 5 — Combo Analytics cards | ✅ | Frontend: collapsible section with `ComboAnalyticsCard` |
| 6 — Combo timeline | ⏭️ | Skipped — deferred to future iteration |
| 7 — Rebuild + verify | ✅ | Both server and client compile; endpoints respond |

## Files Modified

| File | Changes |
|------|---------|
| `server/src/routes/analytics.ts` | Add `requested_model` filter to `/requests`; add new `GET /by-combo` endpoint |
| `client/src/pages/AnalyticsPage.tsx` | Add Type column + combo filter in Recent Calls; add Combo Analytics section with `ComboAnalyticsCard` component |
| `client/src/pages/PlaygroundPage.tsx` | Fetch combos from `/api/combos`, show in model dropdown with strategy badges |
| `client/src/components/model-combobox.tsx` | Render strategy badge for combo options (fallback/round-robin/fusion) instead of "New" badge |

## Endpoints

### `GET /api/analytics/requests?requested_model=<name>`

New optional filter parameter. Accepts any string (combo name, `auto`, `fusion`). Empty string returns 400.

### `GET /api/analytics/by-combo?range=<range>`

Returns per-combo analytics:

```json
{
  "combos": [{
    "comboName": "my-combo",
    "totalRequests": 42,
    "successRate": 95.2,
    "avgLatencyMs": 1234,
    "totalInputTokens": 50000,
    "totalOutputTokens": 15000,
    "modelDistribution": [
      { "modelId": "gpt-4o", "count": 30, "pct": 71.4, "avgLatencyMs": 1100, "successRate": 96.7 }
    ],
    "fallbackDepth": [
      { "ordinal": 1, "modelId": "gpt-4o", "count": 35, "pct": 83.3 }
    ]
  }]
}
```

Only rows where `requested_model` is NOT `null`, `'auto'`, `'fusion'`, or equal to `model_id` (pinned) are counted as combo requests.

## UI Components

### Type Column (Recent Calls)

| Condition | Display |
|-----------|---------|
| `requestedModel === null` or `=== modelId` | `—` (pinned/none) |
| `requestedModel === 'auto'` | `Auto` badge |
| `requestedModel === 'fusion'` | `Fusion` badge |
| Any other value | Combo name badge (secondary variant) |

### Combo Filter Dropdown

A `<Select>` next to the status/provider filters with options:
- All / Auto / Fusion / Combo: name1 / Combo: name2 / ...

Filters via `requested_model` query parameter.

### ComboAnalyticsCard

Each combo gets a card with:
- **Summary row:** name, total requests, success rate, avg latency, token counts
- **Model distribution:** horizontal stacked bar showing which models served requests, with color legend
- **Fallback depth:** horizontal stacked bar showing attempt ordinal distribution (green=first, amber=second, red=third+)

### Playground Model Picker

Combo names appear after `fusion` and before regular models. Each shows a strategy badge (`fallback` / `round-robin` / `fusion`). Selecting a combo works as a model id — the proxy intercepts it and routes accordingly.

## Bug Fixes Applied

| # | Bug | Root Cause | Fix |
|---|-----|------------|-----|
| 1 | Auto filter shows no results | Auto-routed requests have `requested_model = NULL`, but filter used `requested_model = 'auto'` | Map `'auto'` to `IS NULL` in SQL |
| 2 | Combo ordering not respected | `orderChain()` re-sorted combo chain by intelligence_rank | Added `skipSort` param to `routeRequest()`; combo chains pass `skipSort: true` |
| 3 | `/by-combo` endpoint SQL error | Column `at.attempt_ordinal` doesn't exist (correct name: `at.ordinal`) | Renamed to `ordinal` in SQL, TypeScript type, and response mapping |

### Files changed for fixes

| File | Change |
|------|--------|
| `server/src/services/router.ts` | Add `skipSort` parameter to `routeRequest()`; skip `orderChain` when `skipSort=true` |
| `server/src/routes/proxy.ts` | Pass `!!resolvedCombo` as `skipSort` to `routeRequest` for combo chains |
| `server/src/routes/analytics.ts` | Fix Auto filter (`'auto'` → `IS NULL`); fix SQL column `attempt_ordinal` → `ordinal` |
| `client/src/i18n/locales/en.json` | Add `requestType`, `comboAnalytics`, `comboAnalyticsHint`, `noComboData`, `modelDistribution`, `fallbackDepth` keys |

## Build Status

- ✅ Server: `tsc --noEmit` passes
- ✅ Client: `npm run build -w client` passes  
- ✅ All new endpoints respond (verified via curl)

## Future Work

- **Per-combo daily timeline:** Line chart showing request volume per day per combo
- **Combo cost comparison:** Side-by-side cost per request for each strategy
- **Fallback chain visualization:** Sankey diagram showing model-to-model fallback flows
- **Alerts:** Notify when a combo's success rate drops below threshold
- **Combo testing in Playground:** "Run in Playground" button from combo card
