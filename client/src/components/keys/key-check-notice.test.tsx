// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import type { Locale } from '@/i18n/locale-config'
import en from '@/i18n/locales/en.json'
import de from '@/i18n/locales/de.json'
import { KeyCheckNotice } from './key-check-notice'
import { noAutoCheckHintKey } from './key-check-hint'

// #1545: a Free.ai key (no check that spends nothing) showed "unchecked" with
// a red error line. Unknown validity is information, not a fault.

let root: Root
let container: HTMLDivElement
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function mount(props: ComponentProps<typeof KeyCheckNotice>, locale: Locale = 'en', expected?: string) {
  act(() => root.render(
    <I18nProvider initialLocale={locale}>
      <KeyCheckNotice {...props} />
    </I18nProvider>,
  ))
  if (!expected) return
  const deadline = Date.now() + 2_000
  while (!container.textContent?.includes(expected) && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  expect(container.textContent).toContain(expected)
}

const STALE = 'Free.ai has no verified credential-validation endpoint; key validity is unknown (no quota spent)'

describe('KeyCheckNotice (#1545)', () => {
  it('explains a quota-only provider in grey, never as an error, even with a stale stored error', async () => {
    await mount({ autoHealthCheck: false, keyCheckUnavailable: 'quota', status: 'unknown', lastHealthError: STALE }, 'en', en.keys.noAutoCheckQuotaHint)
    const line = container.querySelector('[role="status"]')!
    expect(line.className).toContain('text-muted-foreground')
    expect(line.className).not.toContain('text-destructive')
    expect(container.textContent).not.toContain(STALE)
  })

  it('keeps the "not allowed" wording for providers that forbid checks', async () => {
    await mount({ autoHealthCheck: false, keyCheckUnavailable: 'forbidden', status: 'unknown', lastHealthError: null }, 'en', en.keys.noAutoCheckHint)
  })

  it('says nothing once the key has served a request and turned healthy', async () => {
    await mount({ autoHealthCheck: false, keyCheckUnavailable: 'quota', status: 'healthy', lastHealthError: null })
    expect(container.textContent).toBe('')
  })

  it('still shows a real probe failure on a checked provider in red', async () => {
    await mount({ autoHealthCheck: true, status: 'invalid', lastHealthError: 'Groq rejected the API key' }, 'en', 'Groq rejected the API key')
    expect(container.querySelector('[role="status"]')!.className).toContain('text-destructive')
  })

  it('is localized', async () => {
    await mount({ autoHealthCheck: false, keyCheckUnavailable: 'quota', status: 'unknown', lastHealthError: null }, 'de', de.keys.noAutoCheckQuotaHint)
  })

  it('picks the hint key from the reason', () => {
    expect(noAutoCheckHintKey('quota')).toBe('keys.noAutoCheckQuotaHint')
    expect(noAutoCheckHintKey('forbidden')).toBe('keys.noAutoCheckHint')
    expect(noAutoCheckHintKey(undefined)).toBe('keys.noAutoCheckHint')
  })
})
