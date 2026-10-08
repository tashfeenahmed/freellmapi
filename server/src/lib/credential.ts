/** The sentinel the Keys page stores for key-optional platforms and auth-off
 * custom endpoints (routes/keys.ts keeps `no-key`), plus the empty string a
 * caller can hand a provider when no credential exists. Anything else is a
 * real key (#1331). */
export const NO_KEY_SENTINEL = 'no-key';

export function isAnonymousCredential(apiKey: string | null | undefined): boolean {
  const v = apiKey?.trim() ?? '';
  return v === '' || v === NO_KEY_SENTINEL;
}

/** `Authorization: Bearer <key>` for a real key, nothing for the sentinel:
 * upstreams read `Bearer no-key` as an invalid key, so anonymous calls must
 * omit the header entirely (#1331). */
export function bearerAuthHeader(apiKey: string | null | undefined): Record<string, string> {
  if (isAnonymousCredential(apiKey)) return {};
  return { Authorization: `Bearer ${apiKey!.trim()}` };
}
