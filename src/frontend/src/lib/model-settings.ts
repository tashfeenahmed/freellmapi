// Per-provider model settings edited on the model detail page (#551).
//
// The form holds every numeric field as a string (that is what an <input>
// gives us), so parsing, validation and the PATCH body are pure functions
// here instead of being spread through the component. The bounds mirror the
// Zod schema on PATCH /api/models/:id — the server stays the authority, this
// just keeps the Save button honest.

// The fields the model page can override, in the order they are rendered.
export const RANK_FIELDS = ['intelligenceRank', 'speedRank'] as const
export const LIMIT_FIELDS = ['rpmLimit', 'rpdLimit', 'tpmLimit', 'tpdLimit'] as const

export type RankField = typeof RANK_FIELDS[number]
export type LimitField = typeof LIMIT_FIELDS[number]
export type NumericField = RankField | LimitField | 'contextWindow'
export type EditableField = NumericField | 'displayName' | 'sizeLabel' | 'supportsVision' | 'supportsTools'

export const RANK_MIN = 1
export const RANK_MAX = 1000

// The catalog capability tiers the router scores intelligence with. Anything
// outside these ('' or a custom label) scores as tier 0 — "unknown", not worse
// than the real tiers. Kept in sync with server/src/services/scoring.ts.
export const SIZE_LABELS = ['Frontier', 'Large', 'Medium', 'Small'] as const
export type SizeLabel = typeof SIZE_LABELS[number]

// What the edit form binds to. Numbers are strings; a blank optional number
// means "unset" (null on the wire).
export type ModelSettingsForm = {
  displayName: string
  contextWindow: string
  intelligenceRank: string
  speedRank: string
  sizeLabel: string
  rpmLimit: string
  rpdLimit: string
  tpmLimit: string
  tpdLimit: string
  supportsVision: boolean
  supportsTools: boolean
  fallbackEnabled: boolean
}

// The PATCH body — only the fields the user actually changed. Every field the
// server receives for a catalog model is recorded as a durable override, so
// sending untouched fields would silently freeze them at today's catalog value.
// The limits and the context window accept null ("no limit"), which is stored
// as an override too and therefore survives the next catalog sync.
export type ModelSettingsPatch = {
  displayName?: string
  contextWindow?: number | null
  intelligenceRank?: number
  speedRank?: number
  sizeLabel?: string
  rpmLimit?: number | null
  rpdLimit?: number | null
  tpmLimit?: number | null
  tpdLimit?: number | null
  supportsVision?: boolean
  supportsTools?: boolean
  fallbackEnabled?: boolean
}

// The effective (post-override) model as the API reports it.
export type ModelSettingsSource = {
  displayName: string
  contextWindow?: number | null
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  tpmLimit?: number | null
  tpdLimit?: number | null
  supportsVision: boolean
  supportsTools: boolean
  enabled: boolean
}

export type ModelSettingsReview = {
  // The body to send, or null while anything is invalid.
  patch: ModelSettingsPatch | null
  invalid: Record<EditableField, boolean>
  dirty: boolean
}

function numberFrom(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  return Number.isInteger(value) ? value : undefined
}

// Blank clears the field; anything else must be a positive integer.
// `undefined` means the input is invalid.
export function parseOptionalCount(text: string): number | null | undefined {
  if (text.trim() === '') return null
  const value = numberFrom(text)
  return value !== undefined && value > 0 ? value : undefined
}

// Ranks are required and bounded, same as the PATCH schema.
export function parseRank(text: string): number | undefined {
  const value = numberFrom(text)
  return value !== undefined && value >= RANK_MIN && value <= RANK_MAX ? value : undefined
}

function countText(value: number | null | undefined): string {
  return value == null ? '' : String(value)
}

export function modelSettingsForm(model: ModelSettingsSource): ModelSettingsForm {
  return {
    displayName: model.displayName,
    contextWindow: countText(model.contextWindow),
    intelligenceRank: countText(model.intelligenceRank),
    speedRank: countText(model.speedRank),
    sizeLabel: model.sizeLabel,
    rpmLimit: countText(model.rpmLimit),
    rpdLimit: countText(model.rpdLimit),
    tpmLimit: countText(model.tpmLimit),
    tpdLimit: countText(model.tpdLimit),
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    fallbackEnabled: model.enabled,
  }
}

export function reviewModelSettings(
  model: ModelSettingsSource,
  form: ModelSettingsForm,
): ModelSettingsReview {
  const displayName = form.displayName.trim()
  const parsed = {
    intelligenceRank: parseRank(form.intelligenceRank),
    speedRank: parseRank(form.speedRank),
    contextWindow: parseOptionalCount(form.contextWindow),
    rpmLimit: parseOptionalCount(form.rpmLimit),
    rpdLimit: parseOptionalCount(form.rpdLimit),
    tpmLimit: parseOptionalCount(form.tpmLimit),
    tpdLimit: parseOptionalCount(form.tpdLimit),
  }
  const invalid: Record<EditableField, boolean> = {
    displayName: displayName.length === 0,
    intelligenceRank: parsed.intelligenceRank === undefined,
    speedRank: parsed.speedRank === undefined,
    contextWindow: parsed.contextWindow === undefined,
    rpmLimit: parsed.rpmLimit === undefined,
    rpdLimit: parsed.rpdLimit === undefined,
    tpmLimit: parsed.tpmLimit === undefined,
    tpdLimit: parsed.tpdLimit === undefined,
    sizeLabel: false,
    supportsVision: false,
    supportsTools: false,
  }

  // Only the changed fields go on the wire. An unparseable field reads as
  // `undefined`, which never equals the stored value — so a typo leaves the row
  // dirty with Save disabled, rather than silently looking saved.
  const changes: ModelSettingsPatch = {}
  if (displayName !== model.displayName) changes.displayName = displayName
  if (parsed.intelligenceRank !== model.intelligenceRank) changes.intelligenceRank = parsed.intelligenceRank
  if (parsed.speedRank !== model.speedRank) changes.speedRank = parsed.speedRank
  if (form.sizeLabel !== model.sizeLabel) changes.sizeLabel = form.sizeLabel
  if (parsed.contextWindow !== (model.contextWindow ?? null)) changes.contextWindow = parsed.contextWindow
  if (parsed.rpmLimit !== (model.rpmLimit ?? null)) changes.rpmLimit = parsed.rpmLimit
  if (parsed.rpdLimit !== (model.rpdLimit ?? null)) changes.rpdLimit = parsed.rpdLimit
  if (parsed.tpmLimit !== (model.tpmLimit ?? null)) changes.tpmLimit = parsed.tpmLimit
  if (parsed.tpdLimit !== (model.tpdLimit ?? null)) changes.tpdLimit = parsed.tpdLimit
  if (form.supportsVision !== model.supportsVision) changes.supportsVision = form.supportsVision
  if (form.supportsTools !== model.supportsTools) changes.supportsTools = form.supportsTools
  if (form.fallbackEnabled !== model.enabled) changes.fallbackEnabled = form.fallbackEnabled

  const anyInvalid = Object.values(invalid).some(Boolean)
  return {
    patch: anyInvalid ? null : changes,
    invalid,
    dirty: Object.keys(changes).length > 0,
  }
}
