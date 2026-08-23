import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from '../design-system/Tooltip'
import { ToastProvider, useToast } from '../design-system/Toast'

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows after delay on focus and hides on Escape', async () => {
    render(
      <Tooltip content="Copy to clipboard" delay={100}>
        <button type="button">Copy</button>
      </Tooltip>,
    )
    const trigger = screen.getByText('Copy')
    act(() => {
      trigger.focus()
    })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    const bubble = screen.getByRole('tooltip')
    expect(bubble).toHaveTextContent('Copy to clipboard')
    // describedby wiring
    expect(trigger.parentElement?.querySelector('[aria-describedby]')).toBeInTheDocument()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

function ToastButton() {
  const toast = useToast()
  return (
    <button
      type="button"
      onClick={() => toast.show({ title: 'Saved', message: 'Settings updated.', variant: 'success', duration: 1000 })}
    >
      Trigger toast
    </button>
  )
}

describe('Toast', () => {
  it('renders in a live region and auto-dismisses', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <ToastProvider>
        <ToastButton />
      </ToastProvider>,
    )
    await user.click(screen.getByText('Trigger toast'))

    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(region).toHaveTextContent('Saved')
    expect(region).toHaveTextContent('Settings updated.')

    act(() => {
      vi.advanceTimersByTime(1200)
    })
    await waitFor(() => expect(region).not.toHaveTextContent('Saved'))
    vi.useRealTimers()
  })

  it('can be dismissed via its dismiss button', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ToastButton />
      </ToastProvider>,
    )
    await user.click(screen.getByText('Trigger toast'))
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Notifications' })).not.toHaveTextContent('Saved'),
    )
  })
})
