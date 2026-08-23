import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Input } from '../design-system/Input'
import { Textarea } from '../design-system/Textarea'
import { Select } from '../design-system/Select'

describe('Input', () => {
  it('associates label with input and supports typing', async () => {
    const user = userEvent.setup()
    render(<Input label="Project name" />)
    const input = screen.getByLabelText('Project name')
    await user.type(input, 'my-repo')
    expect(input).toHaveValue('my-repo')
  })

  it('exposes hint via aria-describedby and error via aria-invalid + alert', () => {
    render(<Input label="Email" hint="We never share it." error="Invalid email" />)
    const input = screen.getByLabelText('Email')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.getAttribute('aria-describedby')).toContain('hint')
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid email')
  })
})

describe('Textarea', () => {
  it('supports typing and error semantics', async () => {
    const user = userEvent.setup()
    render(<Textarea label="Description" />)
    const area = screen.getByLabelText('Description')
    await user.type(area, 'hello')
    expect(area).toHaveValue('hello')
  })
})

describe('Select', () => {
  it('renders options and changes value', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <Select
        label="Visibility"
        onChange={onChange}
        options={[
          { value: 'private', label: 'Private' },
          { value: 'public', label: 'Public' },
        ]}
      />,
    )
    await user.selectOptions(screen.getByLabelText('Visibility'), 'public')
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('shows hint text', () => {
    render(<Select label="Branch" hint="Applies to new projects" options={[{ value: 'main', label: 'main' }]} />)
    expect(screen.getByText('Applies to new projects')).toBeInTheDocument()
  })
})
