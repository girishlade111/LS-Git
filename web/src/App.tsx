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
import { EmptyState, Button } from './design-system'
import { useAuth, useHashRoute } from './auth/context'
import { AuthLayout, FieldError, useAsyncSubmit, SubmitButton } from './views/auth/AuthLayout'

const PUBLIC_ROUTES = new Set(['/login', '/register', '/forgot', '/reset', '/verify-email'])

function Placeholder({ title }: { title: string }) {
  return (
    <EmptyState icon="issue" title={title} description="This area will be populated in an upcoming phase of the roadmap." />
  )
}

/** Full-page loading gate while the session is restored. */
function Booting() {
  return (
    <AuthLayout title="Loading…" description="Restoring your session.">
      <SubmitButton label="Please wait…" />
    </AuthLayout>
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
      <AppShell sidebarCurrent="account" onNavigate={(id) => navigate(id === 'home' ? '/' : `/${id}`)} showRepoContext={false}>
        <AccountView />
      </AppShell>
    )
  }

  const view = path.replace(/^\//, '') || 'overview'

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

// Re-exported for tests
void FieldError
void useAsyncSubmit
