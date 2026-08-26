import { useEffect } from 'react'
import { AppShell } from './shell/AppShell'
import { OverviewView } from './views/OverviewView'
import { DesignSystemView } from './views/DesignSystemView'
import { SettingsView } from './views/SettingsView'
import { AccountView } from './views/AccountView'
import {
  LoginView,
  RegisterView,
  ForgotView,
  ResetView,
  VerifyEmailView,
} from './views/auth'
import { EmptyState } from './design-system'
import { useAuth, useHashRoute } from './auth/context'
import { ProjectsView } from './projects/ProjectsView'
import { NewProjectView } from './projects/NewProjectView'
import { ProjectDetailView } from './projects/ProjectDetailView'
import { RepositoryRoute } from './repository/RepositoryBrowser'
import { IssuesRoute, IssueDetailRoute } from './issues/IssuesRouter'
import { ProjectContextRoute } from './issues/ProjectContextRoute'
import { LabelsView } from './issues/LabelsView'
import { MilestonesView } from './issues/MilestonesView'
import { FormsManagerView } from './issues/FormsManagerView'
import { DiscussionsListPage, DiscussionsDetailPage } from './discussions/DiscussionsPages'
import { BoardsPage } from './pm/BoardsPage'
import { PullsListRouteBridge, PullDetailRouteBridge } from './pulls/PullsRouter'
import { ReleasesView } from './releases/ReleasesView'
import './repository/repository.css'
import './issues/issues.css'
import './discussions/discussions.css'
import './pm/pm.css'
import './pulls/pulls.css'
import './pulls/review.css'
import './releases/releases.css'

const PUBLIC_ROUTES = new Set(['/login', '/register', '/forgot', '/reset', '/verify-email'])

function Placeholder({ title }: { title: string }) {
  return (
    <EmptyState icon="issue" title={title} description="This area will be populated in an upcoming phase of the roadmap." />
  )
}

/** Full-page loading gate while the session is restored. */
function Booting() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--ls-text-secondary)',
        fontSize: 'var(--ls-fs-body)',
      }}
      role="status"
    >
      Restoring session…
    </div>
  )
}

export default function App() {
  const { user, loading } = useAuth()
  const { path, query, navigate } = useHashRoute()

  // Redirect unauthenticated visitors away from app routes.
  useEffect(() => {
    if (!loading && !user && !PUBLIC_ROUTES.has(path)) navigate('/login')
    if (!loading && user && PUBLIC_ROUTES.has(path)) navigate('/')
  }, [loading, user, path, navigate])

  if (loading) return <Booting />

  if (path === '/login') return user ? null : <LoginView />
  if (path === '/register') return <RegisterView />
  if (path === '/forgot') return <ForgotView />
  if (path === '/reset') return <ResetView token={query.get('token') ?? ''} />
  if (path === '/verify-email') return <VerifyEmailView token={query.get('token') ?? ''} />

  if (!user) return null // redirect pending

  if (path === '/account') {
    return (
      <AppShell sidebarCurrent="account" onNavigate={(id) => navigate(id === 'overview' ? '/' : `/${id}`)}>
        <AccountView />
      </AppShell>
    )
  }

  const view = path.replace(/^\//, '') || 'overview'

  // Project routes: /projects, /projects/new, /proj/:owner/:path, /explore
  if (path === '/projects') {
    return (
      <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: 'workspace', project: 'projects', visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
        <ProjectsView />
      </AppShell>
    )
  }
  if (path === '/projects/new') {
    return (
      <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)}>
        <NewProjectView />
      </AppShell>
    )
  }
  if (path.startsWith('/proj/')) {
    const [, , owner, projPath] = path.split('/')
    if (owner && projPath) {
      // Repository browser sub-routes: tree|blob|commits|commit|blame|search
      const segments = path.replace(/#L\d+$/, '').split('/').filter(Boolean)
      const BROWSER_ACTIONS = new Set(['tree', 'blob', 'commits', 'commit', 'blame', 'search', 'edit', 'new', 'branches', 'tags', 'compare', 'network', 'notifications'])
      const action = segments[3]

      if (action === 'discussions') {
        const did = Number(segments[4])
        return (
          <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: owner, project: projPath, visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
            <ProjectContextRoute owner={owner} projectPath={projPath}>
              {(project) => Number.isInteger(did) && did > 0 ? (
                <DiscussionsDetailPage projectId={project.id} did={did} isMaintainer={project.owner?.id === user?.id || user?.admin === true} viewerId={user?.id ?? null} />
              ) : (
                <DiscussionsListPage projectId={project.id} />
              )}
            </ProjectContextRoute>
          </AppShell>
        )
      }

      if (action === 'pm') {
        return (
          <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: owner, project: projPath, visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
            <ProjectContextRoute owner={owner} projectPath={projPath}>
              {(project) => (
                <BoardsPage projectId={project.id} isMaintainer={project.owner?.id === user?.id || user?.admin === true} />
              )}
            </ProjectContextRoute>
          </AppShell>
        )
      }

      // Collaboration routes: pulls · issues · labels · milestones.
      if (action === 'pulls') {
        const prIid = Number(segments[4])
        return (
          <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: owner, project: projPath, visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
            {Number.isInteger(prIid) && prIid > 0 ? (
              <PullDetailRouteBridge owner={owner} projectPath={projPath} iid={prIid} />
            ) : (
              <PullsListRouteBridge owner={owner} projectPath={projPath} navigate={(to: string) => { window.location.hash = to.replace(/^#/, '') }} />
            )}
          </AppShell>
        )
      }
      if (action === 'issues') {
        const iid = Number(segments[4])
        return (
          <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: owner, project: projPath, visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
            {Number.isInteger(iid) && iid > 0 ? (
              <IssueDetailRoute owner={owner} projectPath={projPath} iid={iid} navigate={(to: string) => { window.location.hash = to.replace(/^#/, '') }} />
            ) : (
              <IssuesRoute owner={owner} projectPath={projPath} navigate={(to: string) => { window.location.hash = to.replace(/^#/, '') }} />
            )}
          </AppShell>
        )
      }
      if (action === 'releases') {
        return (
          <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: owner, project: projPath, visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
            <ProjectContextRoute owner={owner} projectPath={projPath}>
              {(project) => (
                <ReleasesView projectId={project.id} isMaintainer={project.owner?.id === user?.id || user?.admin === true} />
              )}
            </ProjectContextRoute>
          </AppShell>
        )
      }

      if (action === 'labels' || action === 'milestones' || action === 'issue_forms') {
        return (
          <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: owner, project: projPath, visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
            <ProjectContextRoute owner={owner} projectPath={projPath}>
              {(project) =>
                action === 'labels'
                  ? <LabelsView projectId={project.id} />
                  : action === 'milestones'
                    ? <MilestonesView projectId={project.id} />
                    : <FormsManagerView projectId={project.id} />
              }
            </ProjectContextRoute>
          </AppShell>
        )
      }

      if (action && BROWSER_ACTIONS.has(action)) {
        return (
          <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: owner, project: projPath, visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
            <RepositoryRoute owner={owner} projectPath={projPath} rawPath={path} query={query} />
          </AppShell>
        )
      }
      return (
        <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)} repo={{ group: owner, project: projPath, visibility: 'Private', tabs: [], currentTab: '', onTab: () => undefined }}>
          <ProjectDetailView owner={owner} path={projPath} />
        </AppShell>
      )
    }
  }
  if (path === '/explore') {
    return (
      <AppShell sidebarCurrent="projects" onNavigate={(id) => navigate(`/${id}`)}>
        <ProjectsView />
      </AppShell>
    )
  }

  function renderView() {
    switch (view) {
      case 'overview': return <OverviewView />
      case 'design-system': return <DesignSystemView />
      case 'settings': return <SettingsView />
      case 'issues': return <Placeholder title="Issues" />
      case 'mrs': return <Placeholder title="Merge requests" />
      case 'groups': return <Placeholder title="Groups" />
      default: return <Placeholder title="Not found" />
    }
  }

  return (
    <AppShell
      sidebarCurrent={view}
      onNavigate={(id) => navigate(id === 'overview' ? '/' : `/${id}`)}
      repo={{
        group: 'ls-git',
        project: 'web',
        visibility: 'Private',
        tabs: [
          { id: 'overview', label: 'Code' },
          { id: 'issues', label: 'Issues', count: 3 },
          { id: 'mrs', label: 'Merge requests' },
          { id: 'settings', label: 'Settings' },
        ],
        currentTab: view,
        onTab: (id) => navigate(id === 'overview' ? '/' : `/${id}`),
      }}
    >
      {renderView()}
    </AppShell>
  )
}
