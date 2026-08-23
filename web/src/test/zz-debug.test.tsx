import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { Combobox } from '../design-system/Combobox'
import { AppShell } from '../shell/AppShell'
import { ToastProvider } from '../design-system/Toast'

const options = [
  { value: 'girish', label: 'Girish Lade' },
  { value: 'ada', label: 'Ada Lovelace' },
  { value: 'linus', label: 'Linus Torvalds' },
]

describe('debug', () => {
  it('combobox filter state', async () => {
    function Harness() {
      const [value, setValue] = useState<string | null>(null)
      return (
        <Combobox
          label="Assignee"
          options={options}
          value={value}
          onChange={(v) => setValue(v)}
        />
      )
    }
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    const input = screen.getByRole('combobox')
    await user.type(input, 'lin')
    console.log('INPUT VALUE:', JSON.stringify((input as HTMLInputElement).value))
    console.log(container.querySelector('.ls-combobox__listbox')?.textContent)
    const opts = screen.getAllByRole('option')
    console.log('OPTION TEXTS:', opts.map((o) => o.textContent))
    expect(true).toBe(true)
  })

  it('appshell navs', () => {
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
                { id: 'issues', label: 'Issues' },
              ],
              currentTab: tab,
              onTab: (id) => {
                setView(id)
                setTab(id)
              },
            }}
          >
            <p>content</p>
          </AppShell>
        </ToastProvider>
      )
    }
    render(<Harness />)
    const navs = screen.getAllByRole('navigation')
    console.log(
      'NAVS:',
      navs.map((n) => n.getAttribute('aria-label')),
    )
    const menus = screen.queryAllByRole('button', { name: 'Open navigation menu' })
    console.log('MENU BTN COUNT:', menus.length)
    expect(true).toBe(true)
  })
})
