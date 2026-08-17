import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Separator } from '@/components/ui/separator'

// Separator is a thin wrapper around @base-ui/react/separator. The base-ui
// Separator renders <div role="separator" aria-orientation="...">.

describe('Separator', () => {
  it('renders a separator with the separator data-slot', () => {
    render(<Separator />)
    const el = screen.getByRole('separator')
    expect(el).toHaveAttribute('data-slot', 'separator')
  })

  it('defaults to horizontal orientation', () => {
    render(<Separator />)
    const el = screen.getByRole('separator')
    expect(el).toHaveAttribute('aria-orientation', 'horizontal')
    expect(el.className).toContain('data-horizontal:h-px')
  })

  it('renders vertical orientation when requested', () => {
    render(<Separator orientation="vertical" />)
    const el = screen.getByRole('separator')
    expect(el).toHaveAttribute('aria-orientation', 'vertical')
    expect(el.className).toContain('data-vertical:w-px')
  })

  it('merges a custom className', () => {
    render(<Separator className="my-sep" />)
    expect(screen.getByRole('separator').className).toContain('my-sep')
  })

  it('passes through element props', () => {
    render(<Separator id="sep-1" />)
    expect(screen.getByRole('separator')).toHaveAttribute('id', 'sep-1')
  })
})
