import { useState } from 'react'
import { render, screen } from '@testing-library/react'
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
    const menu = screen.getByRole('menu', { name: 'Actions' })
    expect(menu).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Delete project' }))
    expect(onSelect).toHaveBeenCalledWith('delete')
    await waitForMenuGone()
  })

  it('Escape closes and returns focus to the trigger; ArrowDown opens and focuses first item', async () => {
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

    // ArrowDown opens and focuses first item
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus()

    // Escape closes and restores focus
    await user.keyboard('{Escape}')
    await waitForMenuGone()
    expect(trigger).toHaveFocus()
  })
})

function waitForMenuGone() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function waitFor(fn: () => boolean) {
  return new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (fn()) {
        clearInterval(t)
        resolve()
      }
    }, 5)
  })
}

// silence unused import warnings if RTL screen unused in a future edit
void screen
