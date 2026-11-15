// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import type { Locale } from '@/i18n/locale-config'
import en from '@/i18n/locales/en.json'
import ru from '@/i18n/locales/ru.json'
import es from '@/i18n/locales/es.json'
import ar from '@/i18n/locales/ar.json'
import zh from '@/i18n/locales/zh-CN.json'
import { ApinexCheckinNotice } from './apinex-checkin-notice'

let root: Root
let container: HTMLDivElement
const onResume = vi.fn()
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  onResume.mockReset()
  container = document.createElement('div'); document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function mount(locale: Locale, expected: string, resuming = false) {
  act(() => root.render(
    <I18nProvider initialLocale={locale}>
      <ApinexCheckinNotice disabled={resuming} resuming={resuming} onResume={onResume} />
    </I18nProvider>,
  ))
  // Non-English dictionaries are lazy-loaded by the real i18n provider.
  const deadline = Date.now() + 2_000
  while (!container.textContent?.includes(expected) && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  expect(container.textContent).toContain(expected)
}

describe.each([
  ['en', en], ['ru', ru], ['es', es], ['ar', ar], ['zh-CN', zh],
] as const)('APINex check-in notice in %s', (locale, dictionary) => {
  it('localizes the explanation, provider link and Resume action', async () => {
    await mount(locale, dictionary.keys.apinexCheckinRequired)
    const link = container.querySelector<HTMLAnchorElement>('a')!
    expect(link.textContent).toContain(dictionary.keys.openApinex)
    expect(link.href).toBe('https://apinex.bond/')
    expect(link.rel).toContain('noopener')
    const button = container.querySelector<HTMLButtonElement>('button')!
    expect(button.textContent).toBe(dictionary.keys.resumeKey)
    act(() => button.click())
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('localizes the pending state and prevents duplicate submissions', async () => {
    await mount(locale, dictionary.keys.resumingKey, true)
    const button = container.querySelector<HTMLButtonElement>('button')!
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe(dictionary.keys.resumingKey)
    act(() => button.click())
    expect(onResume).not.toHaveBeenCalled()
  })
})
