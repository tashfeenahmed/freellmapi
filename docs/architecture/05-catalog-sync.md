# Catalog Sync — Deep Dive

> **Source:** `server/src/services/catalog-sync.ts`, `server/src/services/model-state.ts`, `server/src/db/migrations/`

## 1. Overview

The catalog sync keeps the local model catalog in step with the published catalog at `freellmapi.co`. It runs **twice daily** (and on demand), fetches a **signed catalog**, verifies it against a **pinned Ed25519 public key**, and applies it **transactionally** to the local SQLite database.

### Two Tiers

| Tier | Audience | Refresh Cadence | Auth |
|------|----------|-----------------|------|
| **Live** | Premium license holders | Every 2–3 days | Bearer `premium_license_key` |
| **Monthly** | Free installs | ~30 days | None (public) |

Free installs still self-heal, just on a slower cadence. The bundled migrations remain the **baseline** — a fetched catalog is applied only when **newer than `MIN_CATALOG_VERSION`** (bumped on every model migration), so a stale monthly snapshot can never roll back models added by a newer app version.

---

## 2. Catalog Structure

```typescript
interface Catalog {
  version: string;           // e.g. "2026.06.07"
  generatedAt: string;       // ISO timestamp
  tier: 'live' | 'monthly';
  models: CatalogModel[];    // chat models
  embeddings?: CatalogEmbedding[];       // optional, joined freshness feed
  transcriptionModels?: CatalogTranscriptionModel[]; // STT, own top-level key
  quirks: CatalogQuirk[];    // operational advisories
}
```

### CatalogModel (chat)

| Field | Purpose |
|-------|---------|
| `platform`, `modelId` | Primary key (with `endpoint_scope` for relays) |
| `displayName` | UI name |
| `intelligenceRank` | 1..1000 (1 = best), within provider |
| `speedRank` | 1..11 (catalog hand-assigned, 1 = fastest) |
| `sizeLabel` | `Frontier` \| `Large` \| `Medium` \| `Small` (cross-provider tier) |
| `limits` | `{rpm, rpd, tpm, tpd}` — per-model caps |
| `monthlyTokenBudget` | String label (e.g. `"1M"`, `"2x"`) for headroom guardrail |
| `contextWindow` | Max context (tokens) |
| `enabled` | Catalog-level enable (force-disables if false) |
| `supportsVision` / `supportsTools` | Capability flags |
| `modality` | `'text'` (default) → `models` table; `'image'`/`'audio'` → `media_models` |
| `mediaNote` | Short display for media models |
| `requestStyle` | Adapter flavor (e.g. Cloudflare images: `'json'` \| `'multipart'`) |

### Generative Media & Transcription

- **Media models** (`modality: 'image' | 'audio'`) → `media_models` table, gated by `MEDIA_PLATFORMS` set.
- **Transcription models** → `media_models` with `modality = 'transcription'`, gated by `TRANSCRIPTION_PLATFORMS`.
- Separate top-level keys (`transcriptionModels`, `embeddings`) so older binaries ignore unknown modalities instead of misrouting them as chat models.

---

## 3. Signature Verification

```typescript
const PINNED_CATALOG_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=
-----END PUBLIC KEY-----`;

// Fetch
const res = await fetch(`${catalogBaseUrl()}/v1/latest`, { headers: { Authorization: `Bearer ${key}` } });
const signature = res.headers.get('x-catalog-signature');
const bytes = Buffer.from(await res.arrayBuffer());
const verified = crypto.verify(null, bytes, catalogPublicKey(), Buffer.from(signature, 'base64'));
```

- **Pinned key**: private half never left catalog host.
- **Self-hosted catalog override**: `CATALOG_BASE_URL`, `CATALOG_PUBKEY` env vars.
- **Tamper-proof**: anything unsigned or modified is discarded. Compromised CDN / MITM cannot inject models or quirks.

---

## 4. Application Rules (User Data Protection)

Applied inside **one transaction** (`applyCatalog`):

| Rule | Behavior |
|------|----------|
| Metadata (name, ranks, limits, context, capabilities) | Tracks catalog **unless** user has explicit local override |
| `enabled: false` | **Force-disables** (model dead upstream) |
| `enabled: true` | **Never re-enables** a model the user turned off |
| User-created rows (`source = 'user'`) | **Never updated, never deleted, never adopted** — on `platform:model_id` collision, user row wins, catalog entry skipped |
| Catalog models user deleted | Stay deleted via **tombstones** (`catalog_model_tombstones` table) |
| Auto-retired (410/end-of-life) | **Disabled, not deleted** — catalog listing them enabled lifts retirement (#634) |
| Models vanished from catalog | **Deleted** (fallback_config first, FK order) |

### Provenance Column (`source`)

Replaces the old `size_label NOT IN ('User','Custom')` heuristic. Values:

- `'catalog'` — created by catalog sync
- `'user'` — declarative config, admin add, custom endpoint
- `'declarative'` — from declarative config file

---

## 5. Sync Flow

```
syncCatalog(force=false)
  ├─ GET /v1/latest?since=<appliedVersion> (with Bearer license if set)
  ├─ 304 → up_to_date
  ├─ Verify signature (Ed25519)
  ├─ Parse + structural validation (isCatalog)
  ├─ version < MIN_CATALOG_VERSION? → skipped_older (would roll back migrations)
  ├─ Same version+tier as applied? → up_to_date
  ├─ applyCatalog(db, catalog) → transactional upsert/insert/delete
  ├─ Persist settings: appliedVersion, appliedTier, appliedJSON (verified doc)
  └─ Log counts: updated, inserted, removed, skippedUnknownPlatform, quirks
```

### Boot Re-apply (`reapplyCachedCatalog`)

Migrations run on every boot and re-assert the bundled baseline (INSERT OR IGNORE baseline models the catalog may have deleted). The boot-time network sync 304s on unchanged version and would **NOT** re-apply. Without this step, every restart drifts the DB back toward the baseline until the next catalog version bump.

```
reapplyCachedCatalog()
  ├─ Read SETTING_APPLIED_JSON (cached verified document)
  ├─ Validate + version ≥ MIN_CATALOG_VERSION
  ├─ applyCatalog(db, parsed) → synchronous, no network
  └─ Log: "re-applied cached live v2026.06.07 after boot"
```

- Legacy upgrade: installs with applied-version but no cached doc → clear applied version → next poll fetches full catalog.

---

## 6. Model-Age Gate (30 Days)

Models older than 30 days from `generatedAt` are **excluded from the live tier** (free tier trailing snapshot). The catalog service enforces this; the client just receives what the tier provides.

---

## 7. License Status

```typescript
interface LicenseStatus {
  valid: boolean;
  plan: 'annual' | 'lifetime' | null;
  status: string | null;
  expiresAt: string | null;
  checkedAtMs: number;
}
```

- Cached in settings (`premium_license_status`), refreshed on every sync.
- Entitlement enforced **server-side** at `/v1/latest` — local cache is informational UI state.
- Offline / service down → keep cached status.

---

## 8. Quirks (Operational Advisories)

```typescript
interface CatalogQuirk {
  slug: string;
  title: string;
  body: string;
  severity: 'blocker' | 'warning' | 'info';
  targets: { platform: string | null; modelGlob: string | null }[];
}
```

- Pure content: **replaced wholesale** on every sync (DELETE + INSERT).
- Dashboard surfaces blockers/warnings for affected models.

---

## 9. Settings Keys

| Key | Purpose |
|-----|---------|
| `premium_license_key` | Bearer token for live tier |
| `premium_license_status` | Cached `LicenseStatus` JSON |
| `catalog_applied_version` | Last applied catalog version |
| `catalog_applied_tier` | `'live'` \| `'monthly'` |
| `catalog_applied_json` | Verified catalog document (for boot re-apply) |
| `catalog_last_sync_ms` | Timestamp of last successful sync |
| `catalog_last_error` | Last sync error message |

---

## 10. Scheduler Integration

```typescript
startCatalogSync(scheduler: Scheduler)
  ├─ reapplyCachedCatalog()  // synchronous, no network
  ├─ scheduler.after(10s, run)  // boot delay
  └─ scheduler.every(12h, run)  // twice daily
```

- `run()` = `refreshLicenseStatus()` + `syncCatalog()`
- Kill switch: `CATALOG_SYNC_DISABLED=1`

---

## 11. Migration Seeding vs Hosted Catalog

| Aspect | Bundled Migrations | Hosted Catalog Sync |
|--------|-------------------|---------------------|
| **Authority** | Baseline floor | Live source of truth |
| **Version** | `MIN_CATALOG_VERSION` (date) | `catalog.version` (date) |
| **New models** | Added via migration PR | Appear in next catalog publish |
| **Limit corrections** | Migration PR | Learned from provider errors + catalog update |
| **Retirements** | Migration (disabled + tombstone) | Catalog `enabled: false` → force-disable |
| **Relay models** | Not in catalog | Custom endpoints only (user rows) |
| **Rollback protection** | N/A | `version < MIN_CATALOG_VERSION` → skipped |

### Custom Models / Relay Models

- **Never** come from catalog. Created via:
  - `POST /api/media/custom` (generative media / STT)
  - `POST /api/custom-endpoint` (chat relays)
  - Declarative config file
- Bound to `api_keys` row carrying their endpoint (`key_id` on `models` row).
- `endpoint_scope = 'custom:<base_url_hash>'` distinguishes relays serving same `model_id`.
- Catalog sync **skips** `platform = 'custom'` and unknown platforms (older binary).

---

## 12. Key Functions

| Function | Purpose |
|----------|---------|
| `syncCatalog(force?)` | Fetch → verify → apply (or 304/skip) |
| `applyCatalog(db, catalog)` | Transactional upsert/insert/delete + quirks |
| `reapplyCachedCatalog()` | Boot-time re-apply from verified cache |
| `refreshLicenseStatus()` | Validate license against catalog service |
| `getSyncState()` | Dashboard status panel |
| `startCatalogSync(scheduler)` | Register 12h interval + boot delay |
| `isCatalog(value)` | Structural validation (fail loud on garbled body) |
| `routableContextWindow(platform, modelId, cw)` | GitHub gpt-4.1 override (8000) |

---

## 13. Tables Touched

| Table | Operation |
|-------|-----------|
| `models` | UPSERT chat models (catalog source) |
| `media_models` | UPSERT image/audio/transcription |
| `embedding_models` | UPSERT embeddings (full snapshot) |
| `fallback_config` | Ensure every model has a row |
| `catalog_model_tombstones` | Respect user deletions |
| `quirks` + `quirk_targets` | Replace wholesale |
| `settings` | Persist applied version/tier/json, license status, sync time |

---

## 14. Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CATALOG_BASE_URL` | `https://api.freellmapi.co` | Catalog service endpoint |
| `CATALOG_PUBKEY` | Pinned Ed25519 key | Override for self-hosted catalog |
| `CATALOG_SYNC_DISABLED` | `0` | Kill switch (`1` = disabled) |

---

## 15. Error Handling

| Scenario | Behavior |
|----------|----------|
| Network timeout (20s) | Log warning, keep previous catalog |
| HTTP 304 | `up_to_date`, update `last_sync_ms` |
| HTTP non-2xx | Error, keep previous catalog |
| Missing signature | Discard, error |
| Signature verification FAILED | Discard, **loud error** — "catalog signature verification FAILED — discarding response" |
| Invalid JSON / shape | Discard, error |
| Version older than baseline | `skipped_older`, wait for newer catalog |
| DB unavailable during apply | Transaction rolls back, error, keep previous state |
| License check unreachable | Keep cached status, sync still runs (tier determined server-side) |