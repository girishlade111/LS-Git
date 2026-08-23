import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginView } from '../views/auth'
import { AuthProvider } from '../auth/context'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('auth UI', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    window.location.hash = ''
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    window.location.hash = ''
  })

  /** Route-based mock: deterministic regardless of call order. */
  function mockApi(handlers: Record<string, () => Response>) {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input)
      for (const [fragment, respond] of Object.entries(handlers)) {
        if (url.includes(fragment)) return respond()
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  }

  it('submits credentials to /api/v1/auth/login', async () => {
    const user = userEvent.setup()

    render(
      <AuthProvider>
        <LoginView />
      </AuthProvider>,
    )

    mockApi({
      '/auth/status': () => jsonResponse(200, { authenticated: false }),
      '/auth/login': () =>
        jsonResponse(200, {
          user: { id: 1, username: 'alice' },
          csrf_token: 'x',
        }),
    })

    await user.type(screen.getByLabelText('Username or email'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple 42')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const loginCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/auth/login'))!
    expect(loginCall[0]).toBe('/api/v1/auth/login')
    expect(JSON.parse(loginCall[1]!.body as string)).toEqual({
      login: 'alice',
      password: 'correct horse battery staple 42',
    })
    // Cookie session requested (credentials include is set on every request).
    expect(loginCall[1]!.credentials).toBe('same-origin')
  })

  it('surfaces server-side login failures accessibly', async () => {
    const user = userEvent.setup()

    render(
      <AuthProvider>
        <LoginView />
      </AuthProvider>,
    )

    mockApi({
      '/auth/status': () => jsonResponse(200, { authenticated: false }),
      '/auth/login': () => jsonResponse(400, { message: 'Invalid login or password' }),
    })

    await user.type(screen.getByLabelText('Username or email'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'wrong-password-123')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid login or password')
    // The user stays on the login form.
    expect(screen.getByLabelText('Username or email')).toHaveValue('alice')
  })
})
