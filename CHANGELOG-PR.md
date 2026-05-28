# CHANGELOG — Pull Request Summary

> **Goal:** High-level, concise summary of changes for the author of the original repository `freellmapi` (@tashfeenahmed).
> **Base Commit:** `daf7fdc65bbd6871042f4975efdcab10a7bc320f`
> **Compatibility:** All modifications are 100% backward-compatible and do not disrupt existing global fallback setups.

---

## 1. Backend — Named Model Fallback Profiles

Instead of configuring model priority and enabled status exclusively at a global level, we introduced **Multiple Named Profiles** to create, switch, and persist different fallback priorities.

*   **Database Schema (`server/src/db/index.ts`):** 
    *   Added a `profiles` table to store metadata (ID, name, emoji, color, `is_favorite`, layout configurations, and profile `type`).
    *   Added a junctions table `profile_models` linking profiles to models, tracking individual model prioritization and toggle status.
    *   Seeded and static-pinned a **Default** system profile reflecting the original global priority chain. It is system-protected against deletion, renaming, or favorite-toggling at both the API and UI level.
*   **REST API (`server/src/routes/profiles.ts`):** Implemented clean CRUD endpoints under `/api/profiles/*` to fetch, create, edit, reorder, clone, sort by presets (`intelligence`, `speed`, `budget`), and reset individual profiles.
*   **Routing & Usage Integration:**
    *   Updated request routing (`server/src/services/router.ts`) to resolve the dynamic model fallback chain on-the-fly according to the active profile ID stored in backend settings.
    *   Updated token budget limit calculations (`server/src/routes/fallback.ts`) to respect active profile model constraints dynamically.

---

## 2. Backend — Security & Resilience Hardening

We introduced standard defenses to make this tool a robust product for external users:

*   **API Authorization & timingSafeEqual (`server/src/middleware/auth.ts`):** Added authentication checks for `/api/*` endpoints to defend private keys. Key lookups are compared using constant-time `timingSafeEqual()` to guard against timing attacks.
*   **CORS Policy & Host Protection:** Restricts API consumption only to loopback/local origins, protecting host browsers from CSRF/cross-origin budget abuse.
*   **IP-Spoofing & DNS Rebinding Protection (`server/src/services/proxy.ts`):** Hardened verification of connection headers to ensure DNS rebound clients cannot spoof loopback connections.
*   **SQL Injection Prevention (`server/src/routes/analytics.ts`):** Refactored queries to use structured parameterized arguments instead of raw string concatenation.
*   **Graceful 404 Skipping (`server/src/routes/proxy.ts`):** Instantly skips obsolete or deprecated models throwing `404 Not Found` in the retry-loop instead of triggering infinite rate-limit cooldown waits.

---

## 3. Frontend — Profile Management & Dynamic Views

*   **Interactive Profiles Bar (`client/src/pages/FallbackPage.tsx`):**
    *   Toggles profiles instantly, syncing active priority views. Reverts to the Default profile if the currently active profile is clicked again.
    *   Supports responsive collapsing (hidden custom profiles collapse into a single horizontal `+N` badge) with clean hover overlays.
*   **Advanced View Modes:**
    *   Expanded from a single linear list to 4 highly functional view types: **List**, **Grid**, **Columns (Kanban-style)** and **Groups (Tier-List)**.
    *   Both Columns and Groups mode allow creating, removing, renaming, and mass-toggling blocks.
*   **Drag-and-Drop (DnD) Engine:**
    *   Powered by `@dnd-kit/core` supporting cross-block reordering.
    *   High-performance optimization: customized a hybrid `closestCenter` collision detection strategy, memoized model-chip rendering, and integrated temporary drag-hooks to disable tooltips and snap scrolling during moves, resulting in ultra-smooth 60fps interaction.
*   **Model Archiving:** Added a folding "Model Archive" drawer at the bottom of the page. Models can be archived with a smooth fly-to-target animation, disabling them and removing them from primary UI headers and budget calculations.
*   **Rate Limits Visualization:**
    *   Enriched the list and legend with RPM, TPM, RPD, and TPD metrics.
    *   Supports 3 visual styles: `Text` (minimal inline), `Tags` (pills), and `Detailed` (table-like rows). Options can be toggled to appear `Always`, `On Hover`, or hidden completely.
*   **State Localization:** Transitioned view settings (Compact mode, View Mode, Limits format, and Limits Mode) from local storage to profile-level backend configuration (`layout_config` column), guaranteeing layout persistence across different devices.
