import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Checkbox } from '../design-system/Checkbox'
import { Toggle } from '../design-system/Toggle'

describe('Checkbox', () => {
  it('toggles on click and reports checked state', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Checkbox label="Enable CI" onChange={onChange} />)
    const box = screen.getByLabelText('Enable CI')
    await user.click(box)
    expect(box).toBeChecked()
    expect(onChange).toHaveBeenCalledOnce()
  })
})

describe('Toggle', () => {
  function Harness({ initial }: { initial: boolean }) {
    const [on, setOn] = useState(initial)
    return <Toggle checked={on} onChange={setOn} label="Public pipelines" />
  }

  it('has role=switch with aria-checked', () => {
    render(<Harness initial={false} />)
    expect(screen.getByRole('switch', { name: 'Public pipelines' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('toggles via click and keyboard', async () => {
    const user = userEvent.setup()
    render(<Harness initial={false} />)
    const sw = screen.getByRole('switch')
    await user.click(sw)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    // Native <button> activation via keyboard
    await user.keyboard('{Enter}')
    expect(sw).toHaveAttribute('aria-checked', 'false')
  })
})
