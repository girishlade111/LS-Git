import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppShell } from '../shell/AppShell'
import { ToastProvider } from '../design-system/Toast'

function Harness() {
  const [view, setView] = useState('overview')
  const [tab, setTab] = useState('overview')
  return (
    <ToastProvider>
      <AppShell
        sidebarCurrent={view}
        onNavigate={(id) => {
          setView(id)
          setTab(id)
        }}
        repo={{
          group: 'ls-git',
          project: 'web',
          visibility: 'Private',
          tabs: [
            { id: 'overview', label: 'Code' },
            { id: 'issues', label: 'Issues', count: 3 },
            { id: 'settings', label: 'Settings' },
          ],
          currentTab: tab,
          onTab: (id) => {
            setView(id)
            setTab(id)
          },
        }}
      >
        <h1>{view === 'settings' ? 'Settings page' : view === 'issues' ? 'Issues page' : 'Overview page'}</h1>
      </AppShell>
    </ToastProvider>
  )
}

describe('AppShell', () => {
  it('renders landmarks: primary sidebar nav, breadcrumb, repository tabs', () => {
    render(<Harness />)
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('ls-git')
    expect(screen.getByRole('tablist', { name: 'Repository sections' })).toBeInTheDocument()
    expect(screen.getByText('Overview page')).toBeInTheDocument()
  })

  it('navigates via sidebar and repo context tabs', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('tab', { name: /Issues/ }))
    await waitFor(() => expect(screen.getByText('Issues page')).toBeInTheDocument())

    await user.click(screen.getByRole('tab', { name: 'Settings' }))
    await waitFor(() => expect(screen.getByText('Settings page')).toBeInTheDocument())
  })

  it('opens the mobile navigation drawer from the menu button', async () => {
    const { container } = render(<Harness />)
    // The menu button is display:none on desktop (CSS); jsdom applies no layout,
    // so reach it directly and fire the handler without geometry assumptions.
    const menuButton = container.querySelector<HTMLElement>('.ls-contextbar__menu')!
    expect(menuButton).toHaveAttribute('aria-label', 'Open navigation menu')
    fireEvent.click(menuButton)
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' })
    expect(drawer).toBeInTheDocument()

    fireEvent.click(drawer.parentElement!.querySelector('.ls-drawer__header button')!)
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument(),
    )
  })

  it('skip link targets main content', () => {
    render(<Harness />)
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content')
  })
})
