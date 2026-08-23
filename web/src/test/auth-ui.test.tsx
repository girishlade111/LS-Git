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

  it('submits credentials and follows the sign-in contract', async () => {
    const user = userEvent.setup()
    // First call: /auth/login succeeds; second: /auth/status reports authenticated.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        user: { id: 1, username: 'alice', email: 'a@e.com', admin: false, state: 'active', email_verified: true },
        csrf_token: 'x',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { authenticated: false })) // any refresh

    render(
      <AuthProvider>
        <LoginView />
      </AuthProvider>,
    )

    // AuthProvider's initial status call consumes one mock; re-seed remaining calls.
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { authenticated: false })) // mount status
      .mockResolvedValueOnce(jsonResponse(200, {
        user: { id: 1, username: 'alice' }, csrf_token: 'x',
      })) // login
      .mockResolvedValueOnce(jsonResponse(200, { authenticated: true, user: { id: 1, username: 'alice', email: '', admin: false, state: 'active', email_verified: true } }))

    await user.type(screen.getByLabelText('Username or email'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple 42')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const loginCall = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)
    expect(loginCall).toEqual({ login: 'alice', password: 'correct horse battery staple 42' })
  })

  it('surfaces server-side login failures accessibly', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(jsonResponse(200, { authenticated: false }))

    render(
      <AuthProvider>
        <LoginView />
      </AuthProvider>,
    )
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { authenticated: false }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Invalid login or password' }), { status: 400 }),
      )

    await user.type(screen.getByLabelText('Username or email'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'wrong-password-123')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() =>
      expect(screen.getByText('Invalid login or password')).toBeInTheDocument(),
    )
    // Announced to assistive tech:
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid login or password')
  })
})
