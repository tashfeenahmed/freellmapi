// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from '@/components/ui/table'

// Table is a presentational wrapper set around <table> semantics. These tests
// pin the data-slot contract and the container/table split.

describe('Table', () => {
  it('renders a full table with header, body, footer, row, cells and caption', () => {
    render(
      <Table>
        <TableCaption>Model inventory</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>gpt-4o</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>2 models</TableCell>
          </TableRow>
        </TableFooter>
      </Table>,
    )
    // Table wraps the <table> in a scroll container div.
    const container = screen.getByText('gpt-4o').closest('table')?.parentElement
    expect(container).toHaveAttribute('data-slot', 'table-container')
    const table = screen.getByRole('table')
    expect(table).toHaveAttribute('data-slot', 'table')
    expect(screen.getByText('Model inventory')).toHaveAttribute('data-slot', 'table-caption')
    expect(screen.getByText('Name')).toHaveAttribute('data-slot', 'table-head')
    expect(screen.getByText('gpt-4o')).toHaveAttribute('data-slot', 'table-cell')
    expect(screen.getByText('2 models')).toHaveAttribute('data-slot', 'table-cell')
    // Header/footer/body rows all get the table-row slot.
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.getByText('Name').closest('thead')).toHaveAttribute('data-slot', 'table-header')
    expect(screen.getByText('gpt-4o').closest('tbody')).toHaveAttribute('data-slot', 'table-body')
    expect(screen.getByText('2 models').closest('tfoot')).toHaveAttribute('data-slot', 'table-footer')
  })

  it('merges a custom className on the table', () => {
    render(
      <Table className="my-table">
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )
    expect(screen.getByRole('table').className).toContain('my-table')
  })

  it('passes through props on cells and rows', () => {
    render(
      <Table>
        <TableBody>
          <TableRow data-testid="r1">
            <TableCell colSpan={2}>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )
    const row = screen.getByTestId('r1')
    expect(row).toHaveAttribute('data-slot', 'table-row')
    expect(screen.getByText('x')).toHaveAttribute('colspan', '2')
  })
})
