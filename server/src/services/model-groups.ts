/**
 * Model grouping — "unify" the same logical model that several providers serve
 * into ONE item. The `models` table keeps one row per (platform, model_id); a
 * model offered by N providers is N rows. This module computes a logical group
 * for those rows at runtime (NO schema change) from the curated `display_name`,
 * plus operator overrides stored as JSON in the existing `settings` table.
 *
 * Pure by design: the core functions (normalizeGroupKey / groupRows /
 * resolveRequestedIdToMembers) take rows as arguments and touch no globals, so
 * they're trivially unit-testable. Only the settings getters/setters and the
 * getModelGroups() convenience touch the DB.
 *
 * Gated by the `unify_models_enabled` setting (default ON). When OFF, callers
 * keep their pre-unification behavior.
 */
import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';
import {
  ENDPOINT_ID_SEPARATOR,
  endpointRefMatches,
  qualifiedModelMemberId,
} from '../lib/endpoint-scope.js';

// ── Settings keys ────────────────────────────────────────────────────────────
export const UNIFY_ENABLED_KEY = 'unify_models_enabled';
export const UNIFY_OVERRIDES_KEY = 'model_unify_overrides';

export const unifyOverridesSchema = z.object({
  // Coalesce several grouping tokens into one group keyed by `into`. Each key is
  // a normalized display-name OR an exact "platform:model_id" member id.
  merges: z.array(z.object({
    into: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1),
  })).default([]),
  // Force a specific "platform:model_id" row out of its computed group into a
  // singleton (or into an explicit groupKey).
  splits: z.array(z.object({
    member: z.string().min(1),
    groupKey: z.string().optional(),
  })).default([]),
}).default({ merges: [], splits: [] });

export type UnifyOverrides = z.infer<typeof unifyOverridesSchema>;

const EMPTY_OVERRIDES: UnifyOverrides = { merges: [], splits: [] };

// ── Types ────────────────────────────────────────────────────────────────────
// The minimal row shape grouping needs. Catalog queries select more columns;
// extra fields are ignored here and preserved on `members`.
export interface GroupableRow {
  model_db_id: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank?: number;
  // Which custom endpoint this row belongs to; '' (or absent) for every catalog
  // platform and for legacy un-scoped custom rows (#651).
  endpoint_scope?: string;
}

/**
 * How a resolved member was reached: by its own model_id (or a group the
 * operator built), versus only through a group's auto-derived slug.
 */
export type MatchTier = 'literal' | 'slug';

export interface TieredMember {
  modelDbId: number;
  tier: MatchTier;
}

export interface ModelGroup {
  groupKey: string;        // normalized display name — the grouping identity
  canonicalId: string;     // stable slug advertised on /v1/models
  groupLabel: string;      // human label = representative member's stripped name
  members: GroupableRow[]; // all rows in the group (any enabled state)
  // True when an operator override (a merge or an explicit group key) put this
  // group together, rather than the catalog's display names doing it by
  // accident. A slug match on a name the user asserted themselves is a
  // first-class answer; one on an auto-derived slug is only a fallback.
  userDefined: boolean;
}

// ── Settings accessors ───────────────────────────────────────────────────────
// Unification is now always on: a model served by several providers is always
// shown as one logical model that fails over across its providers. The on/off
// toggle was removed from the UI, so a user who previously turned it off is
// still unified. (setUnifyEnabled + the stored setting remain only so the
// settings endpoint stays backward-compatible; the value is ignored here.)
export function isUnifyEnabled(): boolean {
  return true;
}

export function setUnifyEnabled(on: boolean): void {
  setSetting(UNIFY_ENABLED_KEY, on ? '1' : '0');
}

export function getUnifyOverrides(): UnifyOverrides {
  const raw = getSetting(UNIFY_OVERRIDES_KEY);
  if (!raw) return EMPTY_OVERRIDES;
  try {
    const parsed = unifyOverridesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* corrupt JSON → safe default */ }
  return EMPTY_OVERRIDES;
}

export function setUnifyOverrides(input: unknown): UnifyOverrides {
  const norm = unifyOverridesSchema.parse(input);
  setSetting(UNIFY_OVERRIDES_KEY, JSON.stringify(norm));
  return norm;
}

// ── Normalization ────────────────────────────────────────────────────────────
// Catalog display names tag the provider/variant in a trailing parenthetical:
// "GPT-OSS 120B (Groq)", "Llama 3.3 70B (HF)", "... (free)". Strip ONE trailing
// "(...)" (no nested parens) to recover the logical name. Genuine variants like
// "Llama 3.3 70B fp8-fast (CF)" strip to "Llama 3.3 70B fp8-fast" — a DISTINCT
// name that only merges into "Llama 3.3 70B" via an override (by design).
export function stripProviderSuffix(displayName: string): string {
  let s = (displayName ?? '').trim();
  // Iteratively drop trailing markers: a "(...)" provider/variant parenthetical,
  // or a standalone "free" word. "Free" is a pricing tier, not a different model
  // — "DeepSeek V4 Flash Free" is the same model as "DeepSeek V4 Flash" — so it's
  // normalized away so the two group together. (A model literally named just
  // "Free" is left alone: the regex needs a word before it.)
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\s*\([^()]*\)\s*$/, '').trim();
    s = s.replace(/\s+free$/i, '').trim();
  } while (s !== prev);
  return s;
}

// The grouping identity: suffix-stripped, lowercased, with hyphens/underscores/
// whitespace all treated as one separator — so catalog spelling differences like
// "Qwen3 Coder" vs "Qwen3-Coder" group together. Meaningful characters such as
// '+' are kept, so "Command R" and "Command R+" stay distinct.
export function normalizeGroupKey(displayName: string): string {
  return stripProviderSuffix(displayName).toLowerCase().replace(/[\s\-_]+/g, ' ').trim();
}

// A stable, human-friendly slug for the API. Keeps digits and dots ("3.3").
export function slugifyGroupLabel(label: string): string {
  const slug = (label ?? '').toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'model';
}

// ── Grouping ─────────────────────────────────────────────────────────────────
function memberId(row: GroupableRow): string {
  return `${row.platform}:${row.model_id}`;
}

/**
 * The endpoint-qualified member id, or null when the row needs no qualifier.
 * Only custom rows that actually carry an endpoint scope have one, which is why
 * an install with a single relay never sees a qualified id anywhere (#651).
 */
export function qualifiedMemberId(row: GroupableRow): string | null {
  return qualifiedModelMemberId(row.platform, row.model_id, row.endpoint_scope);
}

// The grouping token for a row, after applying overrides. Split wins first
// (forces a singleton/explicit key); then a merge redirects to its target;
// otherwise the normalized display name.
function tokenForRow(row: GroupableRow, ov: UnifyOverrides): string {
  return tokenSourceForRow(row, ov).token;
}

/** The grouping token plus whether an operator override chose it. */
function tokenSourceForRow(row: GroupableRow, ov: UnifyOverrides): { token: string; userDefined: boolean } {
  const mid = memberId(row);
  // A qualified id names ONE relay's copy, so an override written against it
  // must only move that copy. Plain member ids keep matching as before, which is
  // what makes existing overrides survive untouched.
  const qid = qualifiedMemberId(row);
  const names = (candidate: string) => candidate === mid || (qid !== null && candidate === qid);

  const split = ov.splits.find(s => names(s.member));
  if (split) {
    return split.groupKey
      ? { token: normalizeGroupKey(split.groupKey), userDefined: true }
      : { token: `__split__:${split.member}`, userDefined: true };
  }

  const base = normalizeGroupKey(row.display_name);
  const merge = ov.merges.find(mg => mg.keys.some(k => names(k) || normalizeGroupKey(k) === base));
  return merge
    ? { token: normalizeGroupKey(merge.into), userDefined: true }
    : { token: base, userDefined: false };
}

// Assign a unique canonicalId to each group. Deterministic: groups sorted by
// groupKey, slug collisions disambiguated with "-2", "-3", …
function assignCanonicalIds(groups: ModelGroup[]): void {
  const used = new Set<string>();
  for (const g of [...groups].sort((a, b) => a.groupKey.localeCompare(b.groupKey))) {
    const base = slugifyGroupLabel(g.groupLabel);
    let cand = base;
    let n = 2;
    while (used.has(cand)) cand = `${base}-${n++}`;
    used.add(cand);
    g.canonicalId = cand;
  }
}

/**
 * Group catalog rows into logical models. Pure — pass overrides explicitly in
 * tests; defaults to the persisted overrides.
 */
export function groupRows(rows: GroupableRow[], ov: UnifyOverrides): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const row of rows) {
    const { token: key, userDefined } = tokenSourceForRow(row, ov);
    let g = map.get(key);
    if (!g) {
      g = {
        groupKey: key, canonicalId: '', groupLabel: stripProviderSuffix(row.display_name),
        members: [], userDefined: false,
      };
      map.set(key, g);
    }
    g.members.push(row);
    g.userDefined ||= userDefined;
  }

  // Representative label = the best (lowest intelligence_rank) member, tiebroken
  // by shortest stripped name then model_db_id, so the label is deterministic.
  for (const g of map.values()) {
    const rep = [...g.members].sort((a, b) =>
      (a.intelligence_rank ?? Number.MAX_SAFE_INTEGER) - (b.intelligence_rank ?? Number.MAX_SAFE_INTEGER)
      || stripProviderSuffix(a.display_name).length - stripProviderSuffix(b.display_name).length
      || a.model_db_id - b.model_db_id)[0];
    g.groupLabel = stripProviderSuffix(rep.display_name);
  }

  const groups = [...map.values()];
  assignCanonicalIds(groups);
  return groups;
}

/**
 * Resolve a requested model id to the db ids of its group members, or null.
 *
 * The ladder, most specific first:
 *   1. "custom:model_id#endpoint" → exactly that relay's copy (#651) — the only
 *      form that can separate two endpoints offering the same model id. The
 *      endpoint part accepts the short handle or the endpoint URL itself;
 *   2. "platform:model_id" → that platform's copies. Normally exactly one row,
 *      so this is unchanged (#580: naming the platform means "this provider's
 *      copy", no failover to the rest of the group). Two relays sharing a model
 *      id are both 'custom', so this names both and the router picks the better
 *      one — nothing an existing setup can notice, and no error to hit;
 *   3. a canonical group slug OR a bare `model_id` → the union of every group
 *      that answers to it. Display name is presentation, not identity: it may
 *      EXPAND what a bare id reaches (that is the unify feature — one name,
 *      several providers) but it must never SHRINK it. Renaming one relay's
 *      copy, or splitting it out for display, moves it to its own group;
 *      stopping at the first match would strand the other relay, unreachable by
 *      the id every client already has (#651).
 *
 * Member order here is incidental — the router re-orders by the active strategy.
 */
export function resolveRequestedIdToTieredMembers(requested: string, groups: ModelGroup[]): TieredMember[] | null {
  if (!requested) return null;

  const sepAt = requested.lastIndexOf(ENDPOINT_ID_SEPARATOR);
  if (sepAt > 0) {
    const base = requested.slice(0, sepAt);
    const endpointRef = requested.slice(sepAt + 1);
    for (const g of groups) {
      for (const m of g.members) {
        if (memberId(m) !== base) continue;
        if (m.endpoint_scope && endpointRefMatches(endpointRef, m.endpoint_scope)) {
          return [{ modelDbId: m.model_db_id, tier: 'literal' }];
        }
      }
    }
  }

  // Exact "platform:model_id". Checked before the bare model_id scan; a bare
  // model_id that itself contains a colon (e.g. Ollama's "gpt-oss:120b") never
  // collides because platforms aren't model-name prefixes.
  const exact = groups.flatMap(g => g.members.filter(m => memberId(m) === requested));
  if (exact.length > 0) {
    return exact.map(m => ({ modelDbId: m.model_db_id, tier: 'literal' as MatchTier }));
  }

  // Canonical slug and bare model id resolve TOGETHER, as an ORDERED union.
  //
  // Keeping them as separate early-returns let a slug shadow the id: rename one
  // relay's copy and its group's slug is no longer 'deepseek-v3.1', while the
  // untouched relay's group still slugs to exactly that — so the bare id matched
  // one group by slug, returned early, and the renamed relay became unreachable.
  //
  // But the two matches are not equally intended. A canonicalId is a SLUG of a
  // display name, so it can coincide with an unrelated model's literal id (the
  // shipped catalog has one: Cloudflare's "Gemma 4 26B-A4B it" slugs to
  // `gemma-4-26b-a4b-it`, Google's literal model_id in another group). A request
  // written literally must therefore try the literal model FIRST; a coincidental
  // slug sibling is a fallback that may serve only once the real one is
  // exhausted. Groups the operator built by hand rank with the literal matches —
  // they asserted that name themselves.
  const literal: TieredMember[] = [];
  const slugOnly: TieredMember[] = [];
  const seen = new Set<number>();
  for (const g of groups) {
    const byMember = g.members.some(m => m.model_id === requested);
    if (!byMember && g.canonicalId !== requested) continue;
    const bucket = byMember || g.userDefined ? literal : slugOnly;
    const tier: MatchTier = bucket === literal ? 'literal' : 'slug';
    for (const m of g.members) {
      if (seen.has(m.model_db_id)) continue;
      seen.add(m.model_db_id);
      bucket.push({ modelDbId: m.model_db_id, tier });
    }
  }
  const matched = [...literal, ...slugOnly];
  return matched.length > 0 ? matched : null;
}

/**
 * The same resolution, flattened to db ids in tier order. Callers that dispatch
 * a request should prefer the tiered form and pass `demotedMemberIds()` to the
 * router, so a fallback match cannot outrank a literal one on score alone.
 */
export function resolveRequestedIdToMembers(requested: string, groups: ModelGroup[]): number[] | null {
  return resolveRequestedIdToTieredMembers(requested, groups)?.map(m => m.modelDbId) ?? null;
}

/** The subset of a tiered resolution that was reached only through a slug. */
export function demotedMemberIds(members: readonly TieredMember[]): Set<number> {
  return new Set(members.filter(m => m.tier === 'slug').map(m => m.modelDbId));
}

export interface DispatchMembers {
  /** Every member, in tier order. */
  memberDbIds: number[];
  /** Those of them that are fallbacks — hand this to resolveModelGroupCandidates. */
  demotedDbIds: Set<number>;
}

/**
 * One-call resolution for the request path: the member ids to route over plus
 * the ones that must not outrank a literal match on score (#651).
 */
export function resolveRequestedIdForDispatch(
  requested: string,
  groups: ModelGroup[],
): DispatchMembers | null {
  const tiered = resolveRequestedIdToTieredMembers(requested, groups);
  if (!tiered) return null;
  return { memberDbIds: tiered.map(m => m.modelDbId), demotedDbIds: demotedMemberIds(tiered) };
}

// ── DB convenience ───────────────────────────────────────────────────────────

// #1047: GET /api/fallback calls this on every request, and grouping the whole
// catalog (regex + canonical-id assignment over hundreds of rows) dominated the
// handler once the chain read went catalog-wide (#1023). The SELECT itself is a
// cheap pk scan, so run it every time and memoize only the expensive grouping,
// keyed on a fingerprint of the exact inputs — any row change, in place or not,
// and any override change recomputes, so this can never serve stale groups.
let groupsCache: { fingerprint: string; groups: ModelGroup[] } | null = null;

/**
 * Group the whole catalog (enabled + disabled rows so availability can be shown
 * and resolution is complete), applying the persisted overrides.
 */
export function getModelGroups(): ModelGroup[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.endpoint_scope
    FROM models m
    ORDER BY m.id
  `).all() as GroupableRow[];
  const overrides = getUnifyOverrides();
  let fingerprint = JSON.stringify(overrides);
  for (const r of rows) {
    fingerprint += ` ${r.model_db_id}${r.platform}${r.model_id}${r.display_name}${r.intelligence_rank}${r.endpoint_scope ?? ''}`;
  }
  if (groupsCache?.fingerprint === fingerprint) return groupsCache.groups;
  const groups = groupRows(rows, overrides);
  groupsCache = { fingerprint, groups };
  return groups;
}
