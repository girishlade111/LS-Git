import { useState, type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { RepoContextNav, RepoTabs } from './RepoContextNav'
import { Drawer } from '../design-system/Dialog'
import './shell.css'

export interface AppShellProps {
  sidebarCurrent: string
  onNavigate: (id: string) => void
  repo?: {
    group: string
    project: string
    visibility: 'Private' | 'Internal' | 'Public'
    tabs: Array<{ id: string; label: string; count?: number }>
    currentTab: string
    onTab: (id: string) => void
  }
  children: ReactNode
}

/**
 * Application shell: fixed-width dense sidebar + sticky repository context bar
 * + fluid main content. Below 900px the sidebar becomes an off-canvas drawer.
 */
export function AppShell({ sidebarCurrent, onNavigate, repo, children }: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  function navigate(id: string) {
    setMobileNavOpen(false)
    onNavigate(id)
  }

  return (
    <div className="ls-app">
      <a href="#main-content" className="ls-sr-only">
        Skip to main content
      </a>

      {/* Desktop sidebar; slides off-canvas below 900px via CSS transform */}
      <Sidebar current={sidebarCurrent} onNavigate={navigate} open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />

      <div className="ls-main">
        {repo && (
          <>
            <RepoContextNav {...repo} onOpenMobileNav={() => setMobileNavOpen(true)} />
            <RepoTabs tabs={repo.tabs} currentTab={repo.currentTab} onTab={repo.onTab} />
          </>
        )}
        <main id="main-content" tabIndex={-1}>
          <div className="ls-content">{children}</div>
        </main>
      </div>

      {/* Mobile navigation drawer mirrors the sidebar content */}
      <Drawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} title="Navigation" side="left">
        <nav aria-label="Primary mobile">
          {[
            { id: 'overview', label: 'Projects' },
            { id: 'groups', label: 'Groups' },
            { id: 'issues', label: 'Issues' },
            { id: 'mrs', label: 'Merge requests' },
            { id: 'settings', label: 'Settings' },
            { id: 'design-system', label: 'Design system' },
          ].map((item) => (
            <button key={item.id} type="button" className="ls-navitem" onClick={() => navigate(item.id)}>
              {item.label}
            </button>
          ))}
        </nav>
      </Drawer>
    </div>
  )
}
