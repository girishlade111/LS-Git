import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Badge } from '../design-system/Badge'
import { Avatar } from '../design-system/Avatar'
import { StatusIndicator } from '../design-system/StatusIndicator'
import { Table, TBody, TD, TH, THead, TR } from '../design-system/Table'
import { Pagination } from '../design-system/Pagination'
import { EmptyState } from '../design-system/EmptyState'
import { Skeleton } from '../design-system/Skeleton'

describe('Badge / Avatar / StatusIndicator', () => {
  it('renders badge variants', () => {
    render(<Badge variant="danger">failed</Badge>)
    const el = screen.getByText('failed')
    expect(el).toHaveClass('ls-badge--danger')
  })

  it('avatar falls back to initials with accessible name', () => {
    render(<Avatar name="Ada Lovelace" />)
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL')
  })

  it('status indicator provides a readable name', () => {
    render(<StatusIndicator status="success" />)
    expect(screen.getByText('Success')).toBeInTheDocument()
  })
})

describe('Table', () => {
  it('renders semantic headers with scope', () => {
    render(
      <Table aria-label="Branches">
        <THead>
          <TR>
            <TH>Name</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>main</TD>
          </TR>
        </TBody>
      </Table>,
    )
    expect(screen.getByRole('table', { name: 'Branches' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'main' })).toBeInTheDocument()
  })
})

describe('Pagination', () => {
  it('marks the current page and emits changes', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { unmount } = render(<Pagination page={4} pageCount={12} onChange={onChange} />)

    expect(screen.getByRole('button', { current: 'page' })).toHaveTextContent('4')
    await user.click(screen.getByRole('button', { name: 'Page 5' }))
    expect(onChange).toHaveBeenCalledWith(5)
    unmount()

    // Prev disabled on first page
    render(<Pagination page={1} pageCount={3} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
  })

  it('uses ellipsis for long ranges', () => {
    render(<Pagination page={6} pageCount={20} onChange={() => undefined} />)
    expect(screen.getAllByText('…').length).toBeGreaterThan(0)
  })
})

describe('EmptyState / Skeleton', () => {
  it('renders title, description and action', async () => {
    const user = userEvent.setup()
    render(
      <EmptyState
        title="No merge requests"
        description="Create one to get started."
        action={<button type="button">New MR</button>}
      />,
    )
    expect(screen.getByText('No merge requests')).toBeInTheDocument()
    const action = screen.getByRole('button', { name: 'New MR' })
    await user.click(action) // interactive
    expect(action).toBeEnabled()
  })

  it('skeleton is hidden from assistive tech', () => {
    render(<Skeleton width={120} height={10} shape="text" />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
