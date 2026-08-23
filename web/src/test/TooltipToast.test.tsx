import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip } from '../design-system/Tooltip'
import { ToastProvider, useToast } from '../design-system/Toast'

describe('Tooltip', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows after delay on focus, wires describedby, hides on Escape', async () => {
    render(
      <Tooltip content="Copy to clipboard" delay={100}>
        <button type="button">Copy</button>
      </Tooltip>,
    )
    const trigger = screen.getByText('Copy')

    // Not shown before the delay elapses
    fireEvent.focus(trigger)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    const bubble = screen.getByRole('tooltip')
    expect(bubble).toHaveTextContent('Copy to clipboard')
    // The inner wrapper carries aria-describedby while visible
    expect(trigger.parentElement).toHaveAttribute('aria-describedby')

    // Escape hides
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

function ToastButton({ duration }: { duration?: number }) {
  const toast = useToast()
  return (
    <button
      type="button"
      onClick={() =>
        toast.show({
          title: 'Saved',
          message: 'Settings updated.',
          variant: 'success',
          duration,
        })
      }
    >
      Trigger toast
    </button>
  )
}

describe('Toast', () => {
  afterEach(() => vi.useRealTimers())

  it('renders in a live region and auto-dismisses', async () => {
    // Real timers with a short duration keep this deterministic in jsdom.
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ToastButton duration={150} />
      </ToastProvider>,
    )
    await user.click(screen.getByText('Trigger toast'))

    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(region).toHaveTextContent('Saved')
    expect(region).toHaveTextContent('Settings updated.')

    await waitFor(() => expect(region).not.toHaveTextContent('Saved'), { timeout: 2000 })
  })

  it('can be dismissed via its dismiss button', async () => {
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ToastButton duration={Infinity} />
      </ToastProvider>,
    )
    await user.click(screen.getByText('Trigger toast'))
    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Notifications' })).not.toHaveTextContent('Saved'),
    )
  })
})
