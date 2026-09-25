// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

// Popover is a base-ui wrapper. The trigger opens the content in a portal;
// these tests exercise the open/close interaction contract used by the
// FilterBar and other dashboard popovers.

describe('Popover', () => {
  it('renders the trigger button', () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>panel</PopoverContent>
      </Popover>,
    )
    const trigger = screen.getByRole('button', { name: 'Open' })
    expect(trigger).toHaveAttribute('data-slot', 'popover-trigger')
  })

  it('opens the content on click and closes when the user clicks outside', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <button>outside</button>
        <Popover>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>panel content</PopoverContent>
        </Popover>
      </div>,
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const content = await screen.findByText('panel content')
    expect(content).toHaveAttribute('data-slot', 'popover-content')

    // Click outside dismisses the popup.
    await user.click(screen.getByRole('button', { name: 'outside' }))
    await waitFor(() => {
      expect(screen.queryByText('panel content')).not.toBeInTheDocument()
    })
  })

  it('renders children inside the content', async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <button>inner action</button>
        </PopoverContent>
      </Popover>,
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('button', { name: 'inner action' })).toBeInTheDocument()
  })

  it('passes a custom className to the content', async () => {
    const user = userEvent.setup()
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent className="my-panel">panel</PopoverContent>
      </Popover>,
    )
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const content = await screen.findByText('panel')
    expect(content.className).toContain('my-panel')
  })

  it('does not render content before the trigger is opened', () => {
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>panel</PopoverContent>
      </Popover>,
    )
    expect(screen.queryByText('panel')).not.toBeInTheDocument()
    vi.restoreAllMocks()
  })
})
