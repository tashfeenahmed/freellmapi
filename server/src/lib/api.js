export function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const db = getDb();
  const req = db.prepare(`
    SELECT base_url, auth_tag, iv FROM api_keys
    WHERE platform = ? AND enabled = 1
    ORDER BY last_checked_at ASC LIMIT 1`
  ).get('cloudflare');

  if (!req) {
    return fetch(url, options);
  }

  const { base_url: proxyBase, auth_tag, iv } = req;
  const decryptedTag = decrypt(auth_tag, iv, auth_tag);

  const fetchWithAuth = url => {
    const fullUrl = new URL(url).origin === new URL(proxyBase).origin ? url : proxyBase + url;
    return fetch(fullUrl, {
      headers: {
        'X-Auth-Tag': decryptedTag,
        'X-Request-Id': Math.random().toString(36).substring(2)
      }
    });
  };

  return fetchWithAuth(url);
}
