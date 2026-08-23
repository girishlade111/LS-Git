import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type SelfUser } from './api'

interface AuthState {
  user: SelfUser | null
  loading: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SelfUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const status = await api.status()
      setUser(status.authenticated ? (status.user ?? null) : null)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setUser(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo(() => ({ user, loading, refresh, signOut }), [user, loading, refresh, signOut])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

/** Minimal hash router: '#/login', '#/reset?token=x', '' → home. */
export function useHashRoute(): { path: string; query: URLSearchParams; navigate: (to: string) => void } {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, '') || '/'
    const q = raw.indexOf('?')
    return q === -1 ? { path: raw, search: '' } : { path: raw.slice(0, q), search: raw.slice(q + 1) }
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const onChange = () => setRoute(read())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const navigate = useCallback((to: string) => {
    window.location.hash = to
  }, [])
  return { path: route.path, query: new URLSearchParams(route.search), navigate }
}
