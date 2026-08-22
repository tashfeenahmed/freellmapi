import { getCompressionConfig } from './compression/config.js';

/**
 * Dependency-free pluggable-module registry (#763).
 *
 * As the project grows, features that ship as opt-in modules (compression
 * today, a potential paid-model module tomorrow) need a single, tiny registry
 * so operators and dashboards can ask "is module X on?" without reaching into
 * each feature's internals. This module has no third-party dependencies; the
 * flagship compression module is registered here, wired to its existing
 * setting (mode ≠ 'off' counts as enabled).
 *
 * Enabled state can be either a plain boolean (set via enable/disable) or a
 * lazily-evaluated provider function (e.g. reading a setting) — the provider
 * wins when present, so a feature's own config remains the source of truth
 * while the registry stays read-only with respect to it.
 */

export interface ModuleRegistration {
  /** Stable module id, e.g. 'compression'. */
  id: string;
  /** Short human-readable label for dashboards. */
  label: string;
  /** Lazily-evaluated source of truth; when provided it wins over enable/disable. */
  isEnabled?: () => boolean;
}

interface ModuleEntry {
  id: string;
  label: string;
  enabled: boolean;
  provider?: () => boolean;
}

export const COMPRESSION_MODULE_ID = 'compression';

const modules = new Map<string, ModuleEntry>();

/** Register a module. Throws on a duplicate id so wiring bugs surface at boot. */
export function registerModule(reg: ModuleRegistration): void {
  if (modules.has(reg.id)) throw new Error(`Module already registered: ${reg.id}`);
  modules.set(reg.id, {
    id: reg.id,
    label: reg.label,
    enabled: false,
    provider: reg.isEnabled,
  });
}

/** Force-enable a module (no-op when the module has a provider — its config rules). */
export function enableModule(id: string): boolean {
  const entry = modules.get(id);
  if (!entry) return false;
  if (entry.provider) return isModuleEnabled(id);
  entry.enabled = true;
  return true;
}

/** Force-disable a module (no-op when the module has a provider). */
export function disableModule(id: string): boolean {
  const entry = modules.get(id);
  if (!entry) return false;
  if (entry.provider) return isModuleEnabled(id);
  entry.enabled = false;
  return true;
}

/** Whether a module is on: its provider function when present, else the flag. */
export function isModuleEnabled(id: string): boolean {
  const entry = modules.get(id);
  if (!entry) return false;
  return entry.provider ? entry.provider() : entry.enabled;
}

export interface ModuleView {
  id: string;
  label: string;
  enabled: boolean;
  /** True when the module has a provider-backed (config-driven) enabled state. */
  providerBacked: boolean;
}

/** All registered modules, sorted by id for stable dashboards. */
export function listModules(): ModuleView[] {
  return [...modules.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(e => ({
      id: e.id,
      label: e.label,
      enabled: isModuleEnabled(e.id),
      providerBacked: e.provider !== undefined,
    }));
}

/** Test seam: wipe the registry and re-register the built-in modules so a
 *  test that clears between cases still sees compression registered. */
export function _resetModulesForTesting(): void {
  modules.clear();
  registerBuiltinModules();
}

// ── Flagship module: compression ────────────────────────────────────────────
// Wired to the existing `compression` setting: any mode other than 'off'
// counts as enabled. The provider function is evaluated lazily on every
// isModuleEnabled() call, so config changes take effect immediately without a
// re-registration dance.
function registerBuiltinModules(): void {
  registerModule({
    id: COMPRESSION_MODULE_ID,
    label: 'Compression',
    isEnabled: () => getCompressionConfig().mode !== 'off',
  });
}

registerBuiltinModules();
