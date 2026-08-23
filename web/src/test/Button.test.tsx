import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../design-system/Button'
import { IconButton } from '../design-system/IconButton'

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<Button onClick={onClick}>Save changes</Button>)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('applies variant classes', () => {
    const { rerender } = render(<Button variant="primary">P</Button>)
    expect(screen.getByRole('button')).toHaveClass('ls-btn--primary')
    rerender(<Button variant="danger" size="sm">D</Button>)
    expect(screen.getByRole('button')).toHaveClass('ls-btn--danger', 'ls-btn--sm')
  })

  it('does not fire onClick when disabled', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<Button disabled onClick={onClick}>Locked</Button>)
    await user.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('IconButton', () => {
  it('exposes its accessible name from label prop', () => {
    render(<IconButton label="Star project" icon="star" />)
    expect(screen.getByRole('button', { name: 'Star project' })).toBeInTheDocument()
  })

  it('sets aria-pressed only when active', () => {
    const { rerender } = render(<IconButton label="Watch" icon="eye" />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed')
    rerender(<IconButton label="Watch" icon="eye" active />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  })
})
