import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from '@/components/ui/card'

// Card is a presentational composition primitive. These tests pin its
// data-slot contract (used by other components' tests to find rows/sections)
// and the size variant wiring.

describe('Card', () => {
  it('renders with the card data-slot and default size', () => {
    render(<Card>content</Card>)
    const card = screen.getByText('content')
    expect(card).toHaveAttribute('data-slot', 'card')
    expect(card).toHaveAttribute('data-size', 'default')
  })

  it('honors the sm size variant', () => {
    render(<Card size="sm">content</Card>)
    expect(screen.getByText('content')).toHaveAttribute('data-size', 'sm')
  })

  it('merges a custom className', () => {
    render(<Card className="my-custom">content</Card>)
    expect(screen.getByText('content').className).toContain('my-custom')
  })

  it('renders custom element props (id) on the root', () => {
    render(<Card id="card-root">content</Card>)
    expect(screen.getByText('content')).toHaveAttribute('id', 'card-root')
  })
})

describe('Card composition', () => {
  it('renders a full card with header, title, description, content, action and footer', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
          <CardAction>action</CardAction>
        </CardHeader>
        <CardContent>body</CardContent>
        <CardFooter>footer</CardFooter>
      </Card>,
    )
    expect(screen.getByText('Title')).toHaveAttribute('data-slot', 'card-title')
    expect(screen.getByText('Description')).toHaveAttribute('data-slot', 'card-description')
    expect(screen.getByText('action')).toHaveAttribute('data-slot', 'card-action')
    expect(screen.getByText('body')).toHaveAttribute('data-slot', 'card-content')
    expect(screen.getByText('footer')).toHaveAttribute('data-slot', 'card-footer')
    // CardHeader wraps the title/description/action row.
    const header = screen.getByText('Title').parentElement
    expect(header).toHaveAttribute('data-slot', 'card-header')
  })

  it('passes through className and props on each sub-component', () => {
    render(
      <Card>
        <CardHeader className="h-1" data-x="h">
          <CardTitle className="t-1">t</CardTitle>
        </CardHeader>
        <CardContent className="c-1">c</CardContent>
        <CardFooter className="f-1">f</CardFooter>
      </Card>,
    )
    expect(screen.getByText('t').className).toContain('t-1')
    expect(screen.getByText('c').className).toContain('c-1')
    expect(screen.getByText('f').className).toContain('f-1')
    expect(screen.getByText('t').parentElement).toHaveAttribute('data-x', 'h')
  })
})
