// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import cards from '@/data/spanish-verbs.json'
import SpanishVocabPage from './SpanishVocabPage'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<SpanishVocabPage />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const card = () => container.querySelector<HTMLButtonElement>('.vocab-card-face')!
const next = () => container.querySelector<HTMLButtonElement>('[aria-label="Next card"]')!
const previous = () => container.querySelector<HTMLButtonElement>('[aria-label="Previous card"]')!

it('reveals the English translation and flips back to Spanish', () => {
  expect(cards).toHaveLength(500)
  expect(card().textContent).toContain('ser')
  act(() => card().click())
  expect(card().textContent).toContain('to be')
  act(() => card().click())
  expect(card().textContent).toContain('ser')
})

it('navigates through all 500 verbs, resets to Spanish, and stops at the deck boundaries', () => {
  expect(previous().disabled).toBe(true)
  act(() => card().click())
  act(() => next().click())
  expect(card().textContent).toContain('estar')
  expect(card().getAttribute('aria-pressed')).toBe('false')

  act(() => {
    for (let index = 1; index < cards.length - 1; index += 1) next().click()
  })
  expect(next().disabled).toBe(true)
  expect(container.textContent).toContain('500 of 500')
  expect(card().textContent).toContain('adaptarse')
  act(() => card().click())
  expect(card().textContent).toContain('to adapt')
})
