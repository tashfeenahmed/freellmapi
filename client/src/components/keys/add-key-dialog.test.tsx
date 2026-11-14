// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import type { AddedKeyScopeOffer } from './add-key-form'
import { AddKeyDialog } from './add-key-dialog'

// The provider pane's add mutation keeps running after the dialog closes, and
// its success callback (a stale closure of the pane) still reports back. The
// pane is replaced by a stub that hands us that callback.
let reportSuccess: (offer?: AddedKeyScopeOffer) => void = () => {}
vi.mock('./add-key-form', () => ({
  AddKeyForm: ({ onSuccess }: { onSuccess: (offer?: AddedKeyScopeOffer) => void }) => {
    reportSuccess = onSuccess
    return null
  },
}))
vi.mock('./import-keys-section', () => ({ ImportKeysSection: () => null }))
vi.mock('./custom-provider-section', () => ({ CustomProviderSection: () => null }))
vi.mock('./model-select-dialog', () => ({ ModelSelectDialog: () => <div data-testid="scope-picker" /> }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: () => null,
}))

const OFFER: AddedKeyScopeOffer = { keyId: 7, platformLabel: 'Groq', candidates: [] }
let root: Root
let container: HTMLDivElement
const onOpenChange = vi.fn()

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  onOpenChange.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function render(open: boolean) {
  act(() => root.render(<I18nProvider initialLocale="en"><AddKeyDialog open={open} onOpenChange={onOpenChange} /></I18nProvider>))
}
const picker = () => container.querySelector('[data-testid="scope-picker"]')

describe('the add-key scope offer', () => {
  it('opens the scope picker after an add that finishes while the dialog is open', () => {
    render(true)
    act(() => reportSuccess(OFFER))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(picker()).not.toBeNull()
  })

  // Dismissing the dialog while the POST is pending is the user leaving; the
  // key still lands (and its toast says so), but a picker popping up later
  // out of nowhere is not something they asked for.
  it('does not open the picker for an add that finishes after the dialog was dismissed', () => {
    render(true)
    const late = reportSuccess
    render(false)
    act(() => late(OFFER))
    expect(picker()).toBeNull()
  })
})
