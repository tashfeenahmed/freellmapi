// Tiny client-side field validators. Server-side validation stays the source
// of truth; these only power inline field feedback before submit.

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Deliberately loose: enough to catch "no @" or trailing dots, not RFC 5322.
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())
}
