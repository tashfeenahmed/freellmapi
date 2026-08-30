import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyText } from './clipboard'

// The tests run in the default node environment (no jsdom), so `document` and
// `navigator` are stubbed by hand — enough of each for the two copy paths.
function stubDocument(execCommandResult: boolean | (() => boolean)) {
  const selected: string[] = []
  const appended: unknown[] = []
  const removed: unknown[] = []
  const body = {
    appendChild: (node: unknown) => { appended.push(node) },
  }
  const doc = {
    body,
    createElement: () => ({
      value: '',
      style: {} as Record<string, string>,
      setAttribute: () => {},
      select: () => { selected.push('select') },
      setSelectionRange: () => {},
      remove() { removed.push(this) },
    }),
    getSelection: () => null,
    execCommand: () => (typeof execCommandResult === 'function' ? execCommandResult() : execCommandResult),
  }
  vi.stubGlobal('document', doc)
  return { appended, removed, selected }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyText', () => {
  it('uses the async Clipboard API in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { appended } = stubDocument(true)

    expect(await copyText('sk-secret')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('sk-secret')
    // The fallback must not run when the real API worked.
    expect(appended).toHaveLength(0)
  })

  // #734: navigator.clipboard is undefined on an insecure origin, which is what
  // a plain-HTTP LAN install (http://192.168.1.50:4001) is.
  it('falls back to execCommand when there is no Clipboard API', async () => {
    vi.stubGlobal('navigator', {})
    const { appended, removed, selected } = stubDocument(true)

    expect(await copyText('sk-secret')).toBe(true)
    expect(selected).toEqual(['select'])
    // The scratch textarea is always cleaned up.
    expect(appended).toHaveLength(1)
    expect(removed).toEqual(appended)
  })

  it('falls back when the Clipboard API rejects (denied permission)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { appended } = stubDocument(true)

    expect(await copyText('sk-secret')).toBe(true)
    expect(appended).toHaveLength(1)
  })

  it('reports failure when both paths fail, so callers do not claim success', async () => {
    vi.stubGlobal('navigator', {})
    const { removed } = stubDocument(false)

    expect(await copyText('sk-secret')).toBe(false)
    expect(removed).toHaveLength(1)
  })

  it('reports failure — and still cleans up — when execCommand throws', async () => {
    vi.stubGlobal('navigator', {})
    const { removed } = stubDocument(() => { throw new Error('unsupported') })

    expect(await copyText('sk-secret')).toBe(false)
    expect(removed).toHaveLength(1)
  })
})
