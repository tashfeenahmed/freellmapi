// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { CopyButton } from '@/components/copy-button'

describe('CopyButton', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: writeText } })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('copies the text to the clipboard on click', () => {
    render(<CopyButton text="hello world" />)
    fireEvent.click(screen.getByRole('button'))
    expect(writeText).toHaveBeenCalledWith('hello world')
  })

  it('flips to the "Copied" aria-label after click, then reverts', async () => {
    render(<CopyButton text="x" />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-label', 'Copy')
    // The label only flips once the clipboard promise resolves, so flush the
    // microtask queue before asserting.
    await act(async () => {
      fireEvent.click(btn)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(btn).toHaveAttribute('aria-label', 'Copied')
    // The revert rides a 1500ms timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(btn).toHaveAttribute('aria-label', 'Copy')
  })

  it('uses a custom label when provided', () => {
    render(<CopyButton text="x" label="Copy code" />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Copy code')
  })

  it('does not throw when clipboard is unavailable', () => {
    Object.assign(navigator, { clipboard: undefined })
    render(<CopyButton text="x" />)
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow()
  })
})
