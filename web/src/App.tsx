import { useState } from 'react'
import { AppShell } from './shell/AppShell'
import { OverviewView } from './views/OverviewView'
import { DesignSystemView } from './views/DesignSystemView'
import { SettingsView } from './views/SettingsView'
import { EmptyState, Button } from './design-system'

const repoTabs = [
  { id: 'overview', label: 'Code' },
  { id: 'issues', label: 'Issues', count: 3 },
  { id: 'mrs', label: 'Merge requests' },
  { id: 'settings', label: 'Settings' },
  { id: 'design-system', label: 'Design system' },
]

export default function App() {
  const [view, setView] = useState('overview')
  const [tab, setTab] = useState('overview')

  function navigate(id: string) {
    setView(id)
    if (id === 'settings' || id === 'issues' || id === 'mrs' || id === 'design-system' || id === 'groups') {
      setTab(id)
    } else {
      setTab('overview')
    }
  }

  return (
    <AppShell
      sidebarCurrent={view}
      onNavigate={navigate}
      repo={{
        group: 'ls-git',
        project: 'web',
        visibility: 'Private',
        tabs: repoTabs,
        currentTab: tab,
        onTab: (id) => {
          setTab(id)
          setView(id === 'overview' ? 'overview' : id)
        },
      }}
    >
      {view === 'overview' && <OverviewView />}
      {view === 'design-system' && <DesignSystemView />}
      {view === 'settings' && <SettingsView />}
      {(view === 'issues' || view === 'mrs') && (
        <EmptyState
          icon="issue"
          title="Nothing here yet"
          description="This area will be populated in the collaboration phase of the roadmap."
          action={<Button variant="primary" size="sm">New item</Button>}
        />
      )}
      {view === 'groups' && (
        <EmptyState icon="folder" title="No groups" description="Groups organize related projects and members." />
      )}
    </AppShell>
  )
}
