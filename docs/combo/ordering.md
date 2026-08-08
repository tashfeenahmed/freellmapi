# Combo Model Order — Drag-to-Reorder Picker (Phase 3.5)

**Goal:** Replace the checkbox-based model picker in `CombosPage.tsx` with a sortable ordered list using drag-to-reorder, so users can control model priority for fallback and round-robin combos.

## Before / After

| Before | After |
|--------|-------|
| Single checkbox list of all models | Two-section layout: **Selected models** (sortable) + **Add models** (collapsible picker) |
| Click to toggle on/off | Drag to reorder selected models; click `+` to add from available list |
| Order = order of clicking | Order = drag position (first = highest priority) |

## Architecture

The model picker is redesigned as a two-part layout:

```
Models section
├── Selected models — sortable vertical list
│   ├── DndContext + SortableContext (verticalListSortingStrategy)
│   ├── SortableModelItem (drag handle + name + platform badge + X remove)
│   └── arrayMove on drag end
│
└── Add models — <details> collapsible
    └── Available models filtered by !models.includes(o.value)
        └── Click to append to end of selected list
```

## Files Created

| File | Purpose |
|------|---------|
| `client/src/components/sortable-model-item.tsx` | Reusable sortable row with drag handle, model info, remove button |

## Files Modified

| File | Change |
|------|--------|
| `client/src/pages/CombosPage.tsx` | Add DnD imports, sensors, `handleDragEnd`, replace picker section, remove `toggleModel` |
| `client/src/i18n/locales/en.json` | Add `combos.addModels` key |

## Dependencies

- `@dnd-kit/core` — `DndContext`, `closestCenter`, `PointerSensor`, `KeyboardSensor`
- `@dnd-kit/sortable` — `useSortable`, `SortableContext`, `verticalListSortingStrategy`, `arrayMove`
- `@dnd-kit/utilities` — `CSS.Transform`
- `lucide-react` — `X` icon (remove button)
- Shared `dragDots` SVG from `components/model-table.tsx`

## Component: SortableModelItem

A thin wrapper around `useSortable` that renders:

```
┌──────────────────────────────────────────────────────┐
│ ⠿  Model Name (model_id)           [badge]  [✕]     │
└──────────────────────────────────────────────────────┘
```

Props:
- `id` — unique sortable id (prefixed: `combo-model-${modelId}`)
- `modelId` — the model_id value
- `label`, `platform`, `providerCount` — display info
- `onRemove` — remove callback

Drag handle uses the `dragDots` SVG (6 dots) from `model-table.tsx`.

## Interaction Design

- **Drag threshold:** 8px activation distance (prevents accidental drag on click)
- **Keyboard:** `KeyboardSensor` + `sortableKeyboardCoordinates` for tab-to-reorder
- **Remove:** X button removes from `models` state via `filter`
- **Add:** Click any model in the "Add models" collapsible section → appended to end of `models` state
- **Empty selected list:** Sortable section hidden; Add models section still visible

## Edge Cases Handled

- Single model — one row, can't drag but can remove
- All models selected — "Add models" section shows nothing
- No models available — shows `fusion.noModels` message
- Removing all models — submit button disabled (form validation)
- Rapid add/remove — immutable state updates (`filter` / `[...prev, val]`)
- Touch devices — `PointerSensor` with `activationConstraint: { distance: 8 }` prevents accidental drag-on-tap

## i18n

| Key | Default | Used In |
|-----|---------|---------|
| `combos.addModels` | "Add models" | Collapsible section summary |

## Validation Checklist

- [x] Selected models appear as sortable rows with drag handles
- [x] Dragging a model reorders it in the combo's model list
- [x] X button removes a model from the combo
- [x] Available (unselected) models appear in the "Add models" section
- [x] Clicking an available model adds it to the end of the selected list
- [x] The model order in `PATCH /api/combos/:id` matches the visual order
- [x] Creating a new combo preserves the order
- [x] Editing an existing combo shows models in the saved order
- [x] Empty selected list shows no sortable section but still shows "Add models"
- [x] `toggleModel` removed (no dead code)
- [x] No TypeScript errors
- [x] Build succeeds

## Future Work

- **Search/filter** in the "Add models" section (useful with many models)
- **Two-panel transfer** UI (available list on left, selected on right)
- **Model group indicators** — show which combo group each model belongs to (Phase 4)
