// Copy to clipboard, on secure and insecure origins alike (#734).
//
// `navigator.clipboard` only exists in a secure context. A LAN install served
// over plain HTTP — http://192.168.1.50:4001, the documented Docker setup — is
// not one, so the async Clipboard API is simply `undefined` there: every copy
// button either threw or silently did nothing while still flashing "Copied".
//
// The textarea + execCommand path is deprecated but is the only thing that
// works on an insecure origin, and every browser still supports it. It has to
// run inside the user gesture that triggered the copy, so callers must not
// await anything before calling this.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied, or the document was not focused. Fall through.
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false

  const area = document.createElement('textarea')
  area.value = text
  // Off-screen but still selectable: display:none or visibility:hidden would
  // make the selection — and therefore the copy — a no-op. readonly keeps the
  // mobile keyboard from popping up during the flicker.
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '-9999px'
  document.body.appendChild(area)

  // Copying steals the selection, so put back whatever the user had selected.
  const selection = document.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  try {
    area.select()
    area.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    if (previous && selection) {
      selection.removeAllRanges()
      selection.addRange(previous)
    }
  }
}
