# Combos — Frontend Dashboard UI (Phase 3)

**Goal:** Add a Combos management page to the dashboard alongside Fusion/Embeddings/Image/Audio, with full CRUD capabilities.

**Page:** `/models/combos`

## Architecture

The Combos page follows the same pattern as `FusionPage.tsx`:

```
CombosPage
├── PageHeader + ModelsTabs    — tab bar (Chat | Embeddings | Image | Audio | Fusion | Combos)
├── ComboForm (inline)         — create / edit form
├── ComboCard (grid)           — list of existing combos
├── useQuery(['combos'])       — fetch from GET /api/combos
└── useMutation (create/edit/delete) — POST/PATCH/DELETE /api/combos/:id
```

## Files Created

| File | Purpose |
|------|---------|
| `client/src/pages/CombosPage.tsx` | Main combos management page: form, card listing, mutations |

## Files Modified

| File | Change |
|------|--------|
| `client/src/App.tsx` | Import `CombosPage`, add route `/models/combos`, add nav item in `modelItems` |
| `client/src/components/models-tabs.tsx` | Add `<NavLink to="/models/combos">` tab |
| `client/src/i18n/locales/en.json` | Add `models.combosTab` key and full `combos.*` translation block (~40 keys) |

## UI Components

### ComboForm

Inline expand/collapse form used for both create and edit:

- **Name** — text input, immutable on edit (PATCH doesn't support rename)
- **Description** — textarea, optional
- **Strategy** — select: Fallback / Round-robin / Fusion
- **Sticky limit** — number input, visible only when strategy = round-robin
- **Judge model** — model picker select, visible only when strategy = fusion
- **Model picker** — multi-select checkbox list from `/api/fallback` entries, filtered to those with `keyCount > 0 && enabled`. Order is as-selected (drag-to-reorder is future work)

Form validates: name must be non-empty, at least one model selected.

### ComboCard

Card-based layout (grid: 1 col → 2 cols → 3 cols) showing:

- Combo name + strategy badge
- Description (line-clamped)
- Model chips (monospace badge for each model_id)
- Usage hint code block (`model: "combo-name"`)
- Edit / Delete action buttons

### Empty State

When no combos exist: `EmptyState` with Layers icon + "No combos yet" + "Add combo" button.

### Navigation

- **ModelsTabs** — new `<NavLink to="/models/combos">` tab after Fusion
- **modelItems** (App.tsx) — new entry `{ to: '/models/combos', labelKey: 'models.combosTab' }` — surfaces in the nav dropdown and mobile submenu

## i18n Keys

All under `models.combos.*`:

| Key | Purpose |
|-----|---------|
| `title` | Page title |
| `description` | Page description |
| `addCombo` / `editCombo` | Form heading |
| `name` / `descriptionLabel` / `strategy` / `models` | Field labels |
| `strategyFallback` / `strategyRoundRobin` / `strategyFusion` | Strategy names |
| `strategy*Help` | Strategy help text |
| `stickyLimit` / `stickyLimitHelp` | Round-robin only |
| `judgeModel` / `judgeModelHelp` / `judgeAuto` | Fusion only |
| `selectedCount` | Model picker count |
| `create` / `save` / `cancel` | Button labels |
| `created` / `updated` / `deleted` | Success toasts |
| `createError` / `updateError` / `deleteError` | Error toasts |
| `noCombos` / `noCombosDesc` | Empty state |
| `deleteConfirm` | Confirmation dialog |

## Validation Checklist

- [x] CombosPage renders at `/models/combos` with correct title and description
- [x] ModelsTabs shows "Chat | Embeddings | Image | Audio | Fusion | **Combos**"
- [x] Empty state shows "No combos yet" with "Add combo" button
- [x] "Add combo" opens the creation form (name, description, strategy select, model picker)
- [x] Creating a combo calls `POST /api/combos` and shows success toast
- [x] Combo cards display name, strategy badge, model chips, and usage hint
- [x] "Edit" button opens the form pre-filled with existing data
- [x] Saving edits calls `PATCH /api/combos/:id`
- [x] "Delete" shows confirmation dialog, then calls `DELETE /api/combos/:id`
- [x] Form validation: name is required, at least one model selected
- [x] Strategy-dependent fields (sticky limit, judge model) appear/disappear correctly
- [x] Nav dropdown has "Combos" entry under Models section
- [x] Client builds without type errors

## Future Work

- **Model reordering in picker:** Add drag-to-reorder for fallback/round-robin combos
- **Model status indicators:** Show green/red dot for connected/disconnected models
- **Combo usage analytics:** Request-count per combo in the dashboard
- **Combo testing:** "Test" button that sends a quick request via the combo
- **Modal vs inline form:** If the inline form is too tall, switch to a dialog/modal
- **Proper ConfirmDialog:** Replace `window.confirm()` with a proper component
