// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n/I18nProvider'
import { DEFAULT_SAMPLING } from '@/lib/playground-sampling'
import { PLAYGROUND_SKILLS } from '@/lib/playground-skills'
import { SettingsRail, type SettingsRailProps } from './settings-rail'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(onSystemPromptChange: (value: string) => void, systemPrompt = 'Be concise.') {
  const props: SettingsRailProps = {
    open: true,
    onToggle: () => {},
    modelValue: 'auto',
    modelOptions: [],
    onSelectModel: () => {},
    noModels: false,
    dictationValue: 'auto',
    dictationOptions: [],
    onSelectDictation: () => {},
    noTranscription: true,
    systemPrompt,
    onSystemPromptChange,
    sampling: DEFAULT_SAMPLING,
    onSamplingChange: () => {},
    webSearch: false,
    onWebSearchChange: () => {},
    webSearchAvailable: false,
    webSearchChain: '',
  }
  act(() => root.render(
    <I18nProvider initialLocale="en">
      <SettingsRail {...props} />
    </I18nProvider>,
  ))
}

it('applies a selected built-in skill to the existing system prompt', () => {
  const onSystemPromptChange = vi.fn()
  render(onSystemPromptChange)

  const select = container.querySelector<HTMLSelectElement>('#playground-prompt-skill')!
  const apply = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent === 'Apply')!
  expect(apply.disabled).toBe(true)

  act(() => {
    select.value = 'code-review'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(apply.disabled).toBe(false)
  act(() => apply.click())

  expect(onSystemPromptChange).toHaveBeenCalledWith(
    `Be concise.\n\n${PLAYGROUND_SKILLS.find(skill => skill.id === 'code-review')!.prompt}`,
  )
})
