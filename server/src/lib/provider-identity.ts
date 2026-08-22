// ── Provider identity for analytics ─────────────────────────────────────────
// Every custom OpenAI-compatible endpoint shares the platform id 'custom'
// (see services/custom-endpoint.ts), so any analytics view that groups by
// `platform` alone collapses every custom relay into a single "custom" row and
// the operator can no longer tell which endpoint did what (#889).
//
// The canonical identity of a custom endpoint is the serving key's `base_url`
// — custom-endpoint.ts already groups its credential pool by base_url, and the
// router treats every key sharing a base_url as the same endpoint. Grouping by
// base_url therefore splits one endpoint's pooled keys back into a single row
// while keeping distinct endpoints apart.
//
// These helpers produce the stable id + display name the analytics endpoints
// attach to each row. They are pure so they can be unit-tested without a DB —
// module-purity.test.ts enforces that, which is also why they do not import
// endpoint-scope.ts to normalize their input. The base_url they are handed is
// expected to ALREADY be the normalized endpoint identity: keys.ts stores it
// through normalizeBaseUrl(), and routes/analytics.ts re-applies the same
// trailing-slash normalization in SQL for rows written before it did. That
// keeps one definition of "same endpoint" (lib/endpoint-scope.ts) instead of a
// second one hidden in here.

/**
 * The host (and port) of a custom endpoint's base_url — the short identifier
 * that actually tells two endpoints apart. Mirrors the default label
 * convention in services/custom-endpoint.ts (`new URL(baseUrl).host`) but
 * returns null instead of a literal when the URL is unparseable, so callers
 * can fall back to the generic 'custom' id rather than a fake host.
 */
export function endpointHost(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * The stable provider id for an analytics row. Non-custom platforms keep their
 * bare slug ('groq', 'openai', …) so existing filters and the platform dot
 * coloring are untouched. Custom endpoints get 'custom:<base_url>' so two
 * relays never collide; a custom request whose key is gone (or never had a
 * base_url) falls back to the plain 'custom' id, preserving the pre-fix shape.
 */
export function providerIdFor(platform: string, baseUrl: string | null | undefined): string {
  if (platform !== 'custom') return platform;
  // The base_url IS the endpoint-scope token of #651 (see the header), so this
  // id agrees with `models.endpoint_scope` and with the router's view of which
  // keys are one endpoint.
  return baseUrl ? `custom:${baseUrl}` : 'custom';
}

/**
 * The part of a base_url's path that carries identity of its own — '' when the
 * path says nothing a second endpoint on the same host would not also say.
 *
 * The root ('/') and a lone API-version segment ('/v1', '/v1beta', '/v2') are
 * trivial: every relay repeats them, so including them would only add noise to
 * the common one-endpoint-per-host case. Anything else — a tenant, a project,
 * a mount point — is exactly what tells two endpoints on one host apart, so it
 * is kept VERBATIM, version suffix included. Trimming the '/v1' off a kept
 * path would make '…/tenant-a' and '…/tenant-a/v1' display the same, which is
 * the collision this exists to prevent.
 */
function endpointPathLabel(baseUrl: string): string {
  let path: string;
  try {
    path = new URL(baseUrl).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
  if (!path) return '';
  const segments = path.slice(1).split('/');
  if (segments.length === 1 && /^v\d+[a-z0-9._-]*$/i.test(segments[0])) return '';
  return path;
}

/**
 * The display name for an analytics row: the platform slug for catalog
 * providers, and for a custom row the endpoint host plus any non-trivial path.
 *
 * Host alone is not an identity: a single gateway commonly fronts several
 * endpoints ('https://gw.example.com/tenant-a/v1' and '…/tenant-b/v1'), and
 * naming both of them 'gw.example.com' re-creates the #889 collision one level
 * down — two rows the operator cannot tell apart. Appending the path makes the
 * name injective on (host, path), while a bare '…/v1' endpoint still reads as
 * the plain host it is.
 *
 * Derived purely from this row's base_url, like endpoint-scope's handles: the
 * name never changes because some OTHER endpoint appeared or was deleted, so
 * every view (by-platform, by-model, errors) agrees on what to call an
 * endpoint even when they see different subsets of them.
 *
 * A null/unparseable base_url falls back to the platform, so there is always
 * something to render.
 */
export function providerDisplayName(
  platform: string,
  baseUrl: string | null | undefined,
): string {
  if (platform !== 'custom') return platform;
  if (!baseUrl) return platform;
  const host = endpointHost(baseUrl);
  if (!host) return platform;
  return host + endpointPathLabel(baseUrl);
}
