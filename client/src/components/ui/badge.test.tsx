import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Badge, badgeVariants } from '@/components/ui/badge'

// Badge is a small presentational pill with variant styling. It renders a
// <span role=...> via base-ui useRender, and each variant maps to a distinct
// class. These tests pin the variant contract.

describe('Badge', () => {
  it('renders as a span with the default variant class', () => {
    render(<Badge>New</Badge>)
    const el = screen.getByText('New')
    expect(el.tagName).toBe('SPAN')
    expect(el.className).toContain('bg-primary')
  })

  it.each([
    ['default', 'bg-primary'],
    ['secondary', 'bg-secondary'],
    ['destructive', 'bg-destructive/10'],
    ['outline', 'border-border'],
    ['ghost', 'hover:bg-muted'],
    ['link', 'underline-offset-4'],
  ] as const)('renders the %s variant', (variant, expectedClass) => {
    render(<Badge variant={variant}>{variant}</Badge>)
    expect(screen.getByText(variant).className).toContain(expectedClass)
  })

  it('merges a custom className', () => {
    render(<Badge className="my-badge">x</Badge>)
    expect(screen.getByText('x').className).toContain('my-badge')
  })

  it('passes through aria-label', () => {
    render(<Badge aria-label="status">x</Badge>)
    expect(screen.getByText('x')).toHaveAttribute('aria-label', 'status')
  })

  it('exposes badgeVariants for manual composition', () => {
    expect(badgeVariants({ variant: 'destructive' })).toContain('bg-destructive/10')
    expect(badgeVariants()).toContain('bg-primary')
  })
})
