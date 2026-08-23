import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Tabs } from '../design-system/Tabs'
import { Dropdown } from '../design-system/Dropdown'

describe('Tabs', () => {
  function Harness() {
    const [value, setValue] = useState('code')
    return (
      <Tabs
        aria-label="Demo"
        value={value}
        onChange={setValue}
        items={[
          { id: 'code', label: 'Code', content: <p>Code panel</p> },
          { id: 'ci', label: 'CI/CD', content: <p>CI panel</p> },
          { id: 'sec', label: 'Security', content: <p>Security panel</p> },
        ]}
      />
    )
  }

  it('selects on click and renders the active panel', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.getByText('Code panel')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'CI/CD' }))
    expect(screen.getByRole('tab', { name: 'CI/CD' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('CI panel')).toBeVisible()
    expect(screen.queryByText('Code panel')).not.toBeInTheDocument()
  })

  it('supports arrow-key navigation with roving tabindex', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const code = screen.getByRole('tab', { name: 'Code' })
    code.focus()
    await user.keyboard('{ArrowRight}')
    const ci = screen.getByRole('tab', { name: 'CI/CD' })
    expect(ci).toHaveAttribute('aria-selected', 'true')
    expect(ci).toHaveFocus()
    expect(code).toHaveAttribute('tabindex', '-1')
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Code' })).toHaveFocus()
  })
})

describe('Dropdown', () => {
  const items = [
    { kind: 'item' as const, id: 'archive', label: 'Archive project' },
    { kind: 'separator' as const },
    { kind: 'item' as const, id: 'delete', label: 'Delete project' },
  ]

  it('opens on click, selects an item, and calls onSelect', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(
      <Dropdown
        menuLabel="Actions"
        items={items}
        onSelect={onSelect}
        trigger={({ onClick }) => (
          <button type="button" onClick={onClick}>
            Actions
          </button>
        )}
      />,
    )
    await user.click(screen.getByText('Actions'))
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Delete project' }))
    expect(onSelect).toHaveBeenCalledWith('delete')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('ArrowDown opens focusing first item; Escape closes restoring focus', async () => {
    const user = userEvent.setup()
    render(
      <Dropdown
        menuLabel="Actions"
        items={items}
        trigger={({ onClick }) => (
          <button type="button" onClick={onClick}>
            Actions
          </button>
        )}
      />,
    )
    const trigger = screen.getByText('Actions')

    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })
})
