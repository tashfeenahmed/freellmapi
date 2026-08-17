import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Markdown } from '@/components/markdown'

// Markdown renders raw markdown through react-markdown + GFM with custom
// component styling and a copy button on fenced code blocks. These tests
// assert the rendered DOM (headings, links, tables, code copy button) rather
// than the styling classes.

describe('Markdown', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: writeText } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders headings, paragraphs and lists', () => {
    render(<Markdown>{'# Title\n\nSome **bold** text.\n\n- one\n- two'}</Markdown>)
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()
    // "Some **bold** text." renders as a <p> with a nested <strong>, so match
    // the combined textContent of the paragraph element.
    expect(
      screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === 'Some bold text.'),
    ).toBeInTheDocument()
    expect(screen.getByText('bold')).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('renders links with target=_blank and noreferrer', () => {
    render(<Markdown>{'[docs](https://example.com)'}</Markdown>)
    const link = screen.getByRole('link', { name: 'docs' })
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer noopener')
  })

  it('renders GFM strikethrough and tables', () => {
    render(<Markdown>{'~~gone~~\n\n| a | b |\n|---|---|\n| 1 | 2 |'}</Markdown>)
    // The <del> component styles strikethrough text with the opacity-70
    // Tailwind class (jsdom doesn't resolve class-based styles).
    expect(screen.getByText('gone')).toHaveClass('opacity-70')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders a copy button on fenced code blocks with the code text', () => {
    render(<Markdown>{'```js\nconst x = 1;\n```'}</Markdown>)
    const btn = screen.getByRole('button', { name: /copy code/i })
    expect(btn).toBeInTheDocument()
    expect(screen.getByText('const x = 1;')).toBeInTheDocument()
  })

  it('copies the code block text (without trailing newline) on click', () => {
    render(<Markdown>{'```\nline1\nline2\n```'}</Markdown>)
    const btn = screen.getByRole('button', { name: /copy code/i })
    btn.click()
    expect(writeText).toHaveBeenCalledWith('line1\nline2')
  })

  it('renders inline code without a copy button', () => {
    render(<Markdown>{'Use `npm run dev` to start.'}</Markdown>)
    expect(screen.getByText('npm run dev')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /copy code/i })).not.toBeInTheDocument()
  })

  it('renders blockquotes and horizontal rules', () => {
    render(<Markdown>{'> quoted text\n\n---'}</Markdown>)
    expect(screen.getByText('quoted text')).toBeInTheDocument()
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })
})
