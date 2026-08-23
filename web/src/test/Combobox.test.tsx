import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Combobox } from '../design-system/Combobox'

const options = [
  { value: 'girish', label: 'Girish Lade', description: '@girish' },
  { value: 'ada', label: 'Ada Lovelace', description: '@ada' },
  { value: 'linus', label: 'Linus Torvalds', description: '@linus' },
]

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState<string | null>(null)
  return (
    <Combobox
      label="Assignee"
      options={options}
      value={value}
      onChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
    />
  )
}

describe('Combobox', () => {
  it('opens the listbox and selects with Enter after arrowing down', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Harness onChange={onChange} />)

    await user.click(screen.getByRole('combobox'))
    const listbox = screen.getByRole('listbox')
    expect(listbox).toBeInTheDocument()

    await user.keyboard('{ArrowDown}') // girish -> ada
    await user.keyboard('{Enter}')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('ada'))
    // Input reflects selection when closed
    await waitFor(() =>
      expect(screen.getByRole('combobox')).toHaveValue('Ada Lovelace'),
    )
  })

  it('filters options as the user types', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox')
    await user.type(input, 'lin')
    const opts = screen.getAllByRole('option')
    // Options include their description text (e.g. "@linus"), so match loosely.
    expect(opts.some((o) => o.textContent?.includes('Linus Torvalds'))).toBe(true)
    expect(opts.every((o) => !o.textContent?.includes('Ada Lovelace'))).toBe(true)
  })

  it('Escape closes the listbox without changing selection', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const input = screen.getByRole('combobox')
    await user.click(input)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.type(input, 'a')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(input).toHaveValue('')
  })

  it('closes on outside click', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <span>outside</span>
        <Harness />
      </div>,
    )
    await user.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await user.click(screen.getByText('outside'))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })
})
