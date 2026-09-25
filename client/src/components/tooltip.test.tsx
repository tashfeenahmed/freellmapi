// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Tooltip } from '@/components/tooltip'

describe('Tooltip', () => {
  it('renders its trigger children', () => {
    render(
      <Tooltip text="helpful hint">
        <button>Hover me</button>
      </Tooltip>,
    )
    expect(screen.getByText('Hover me')).toBeInTheDocument()
  })

  it('shows the tooltip portal on mouse enter and hides on leave', () => {
    render(
      <Tooltip text="helpful hint">
        <button>Hover me</button>
      </Tooltip>,
    )
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(screen.getByText('Hover me'))
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('helpful hint')
    fireEvent.mouseLeave(screen.getByText('Hover me'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows on focus and hides on blur', () => {
    render(
      <Tooltip text="keyboard hint">
        <button>Focus me</button>
      </Tooltip>,
    )
    fireEvent.focus(screen.getByText('Focus me'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('keyboard hint')
    fireEvent.blur(screen.getByText('Focus me'))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('clamps the x position to the viewport lower bound when the trigger is off-screen left', () => {
    // jsdom reports 0 for getBoundingClientRect; with a realistic viewport the
    // lower clamp (half-width + padding = 124) should win.
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1000)
    render(
      <Tooltip text="clamped">
        <button>Tiny</button>
      </Tooltip>,
    )
    fireEvent.mouseEnter(screen.getByText('Tiny'))
    const tip = screen.getByRole('tooltip')
    expect(tip.style.left).toBe('124px')
  })
})
