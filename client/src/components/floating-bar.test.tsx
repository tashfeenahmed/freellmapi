import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { FloatingBar } from '@/components/floating-bar'

describe('FloatingBar', () => {
  it('renders nothing when hidden and not yet shown', () => {
    const { container } = render(<FloatingBar show={false}>body</FloatingBar>)
    expect(container.querySelector('.fixed')).toBeNull()
  })

  it('renders its children while shown', () => {
    render(<FloatingBar show={true}>action</FloatingBar>)
    expect(screen.getByText('action')).toBeInTheDocument()
  })

  it('keeps the node mounted during the exit animation, then unmounts', () => {
    vi.useFakeTimers()
    const { container, rerender } = render(<FloatingBar show={true}>action</FloatingBar>)
    expect(container.querySelector('.fixed')).not.toBeNull()
    act(() => {
      rerender(<FloatingBar show={false}>action</FloatingBar>)
    })
    expect(container.querySelector('.fixed')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(container.querySelector('.fixed')).toBeNull()
    vi.useRealTimers()
  })

  it('re-shows without re-mounting delay when toggled back on', () => {
    const { container, rerender } = render(<FloatingBar show={false}>action</FloatingBar>)
    expect(container.querySelector('.fixed')).toBeNull()
    rerender(<FloatingBar show={true}>action</FloatingBar>)
    expect(container.querySelector('.fixed')).not.toBeNull()
  })
})
