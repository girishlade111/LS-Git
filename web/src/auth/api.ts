/** Typed API client. Cookie-based sessions; CSRF token attached on mutations. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public extras?: Record<string, unknown>,
  ) {
    super(message)
  }
}

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

let bearerToken: string | null = null
/** PATs entered by advanced users are kept in memory only (never persisted). */
export function setBearerToken(token: string | null): void {
  bearerToken = token
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = readCookie('lsgit_csrf')
    if (csrf) headers['x-csrf-token'] = csrf
  }
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`

  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status === 204) return undefined as T
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(data.message ?? 'Request failed'),
      data.code as string | undefined,
      data,
    )
  }
  return data as T
}

// -- types ------------------------------------------------------------------

export interface SelfUser {
  id: number
  username: string
  name: string | null
  email: string
  admin: boolean
  state: 'active' | 'blocked' | 'deactivated'
  email_verified: boolean
  bio: string | null
  location: string | null
  website_url: string | null
  public_email: string | null
  avatar_url: string
  created_at: string
}

export interface SshKey {
  id: number
  title: string
  key_type: string
  bits: number | null
  fingerprint: string
  comment: string | null
  usage_mode: string
  expires_at: string | null
  created_at: string
}

export interface AccessToken {
  id: number
  name: string
  description: string | null
  scopes: string[]
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

export interface SessionInfo {
  id: number
  ip: string | null
  user_agent: string | null
  created_at: string
  last_active_at: string
  expires_at: string
  current: boolean
}

export interface AuditEvent {
  event: string
  ip: string | null
  created_at: string
}

// -- endpoints ---------------------------------------------------------------

export const api = {
  status: () => request<{ authenticated: boolean; user?: SelfUser }>('/api/v1/auth/status', 'GET'),
  register: (p: { username: string; email: string; name?: string; password: string }) =>
    request<{ user: SelfUser }>('/api/v1/auth/register', 'POST', p),
  login: (p: { login: string; password: string }) =>
    request<{ user: SelfUser }>('/api/v1/auth/login', 'POST', p),
  logout: () => request<{ ok: boolean }>('/api/v1/auth/logout', 'POST'),
  requestPasswordReset: (email: string) =>
    request<{ message: string }>('/api/v1/auth/request-password-reset', 'POST', { email }),
  resetPassword: (reset_token: string, password: string) =>
    request<{ message: string }>('/api/v1/auth/reset-password', 'POST', { reset_token, password }),
  verifyEmail: (verification_token: string) =>
    request<{ ok: boolean }>('/api/v1/auth/verify-email', 'POST', { verification_token }),

  updateProfile: (p: Partial<Pick<SelfUser, 'name' | 'bio' | 'location' | 'website_url' | 'public_email'>>) =>
    request<SelfUser>('/api/v1/user', 'PATCH', p),
  changeUsername: (username: string) => request<SelfUser>('/api/v1/user', 'PATCH', { username }),
  changePassword: (current_password: string, new_password: string) =>
    request<{ ok: boolean }>('/api/v1/user/password', 'PUT', { current_password, new_password }),
  uploadAvatar: (data_base64: string) =>
    request<{ contentType: string; size: number }>('/api/v1/user/avatar', 'PUT', { data_base64 }),
  removeAvatar: () => request<{ ok: boolean }>('/api/v1/user/avatar', 'DELETE'),

  listKeys: () => request<SshKey[]>('/api/v1/user/keys', 'GET'),
  addKey: (p: { title: string; key: string; usage_mode?: string }) =>
    request<SshKey>('/api/v1/user/keys', 'POST', p),
  deleteKey: (id: number) => request<{ ok: boolean }>(`/api/v1/user/keys/${id}`, 'DELETE'),

  listTokens: () => request<AccessToken[]>('/api/v1/user/personal_access_tokens', 'GET'),
  createToken: (p: { name: string; scopes: string[]; expires_in_days: number }) =>
    request<AccessToken & { token: string }>('/api/v1/user/personal_access_tokens', 'POST', p),
  revokeToken: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/user/personal_access_tokens/${id}`, 'DELETE'),

  listSessions: () => request<SessionInfo[]>('/api/v1/sessions', 'GET'),
  revokeSession: (id: number) => request<{ ok: boolean }>(`/api/v1/sessions/${id}`, 'DELETE'),
  revokeOtherSessions: () =>
    request<{ revoked: number }>('/api/v1/sessions/revoke-others', 'POST'),

  auditEvents: () => request<AuditEvent[]>('/api/v1/user/audit_events?limit=50', 'GET'),
}
