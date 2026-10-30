// Copies text the user can already see. Falls back to a hidden textarea where
// the async Clipboard API is unavailable (older WebViews, non-secure origins).
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand?.('copy') ?? false
    ta.remove()
    return ok
  } catch {
    return false
  }
}
