import { useEffect, useRef, useState } from 'react'
import { api, type AccessToken, type AuditEvent, type SelfUser, type SessionInfo, type SshKey } from '../auth/api'
import { useAuth } from '../auth/context'
import { Avatar } from '../design-system/Avatar'
import { Badge } from '../design-system/Badge'
import { Button } from '../design-system/Button'
import { Dialog } from '../design-system/Dialog'
import { EmptyState } from '../design-system/EmptyState'
import { Input } from '../design-system/Input'
import { StatusIndicator } from '../design-system/StatusIndicator'
import { Table, TBody, TD, TH, THead, TR } from '../design-system/Table'
import { useToast } from '../design-system/Toast'

const SECTIONS = [
  { id: 'profile', label: 'Profile' },
  { id: 'password', label: 'Password' },
  { id: 'keys', label: 'SSH Keys' },
  { id: 'tokens', label: 'Access Tokens' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'audit', label: 'Audit' },
]

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="ls-card" style={{ padding: 20 }} aria-label={title}>
      <h2 style={{ fontSize: 'var(--ls-fs-row)', fontWeight: 600 }}>{title}</h2>
      {description && (
        <p style={{ fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-text-secondary)', marginTop: 2 }}>
          {description}
        </p>
      )}
      <div style={{ marginTop: 14 }}>{children}</div>
    </section>
  )
}

function ProfilePanel({ user }: { user: SelfUser }) {
  const toast = useToast()
  const { refresh } = useAuth()
  const [name, setName] = useState(user.name ?? '')
  const [bio, setBio] = useState(user.bio ?? '')
  const [location, setLocation] = useState(user.location ?? '')
  const [website, setWebsite] = useState(user.website_url ?? '')
  const [username, setUsername] = useState(user.username)
  const fileRef = useRef<HTMLInputElement>(null)

  async function saveProfile() {
    await api.updateProfile({ name, bio, location, website_url: website })
    await refresh()
    toast.show({ title: 'Saved', message: 'Profile updated.', variant: 'success' })
  }
  async function saveUsername() {
    if (username === user.username) return
    try {
      await api.changeUsername(username)
      await refresh()
      toast.show({ title: 'Username changed', variant: 'success' })
    } catch (err) {
      toast.show({ title: 'Failed', message: err instanceof Error ? err.message : undefined, variant: 'danger' })
      setUsername(user.username)
    }
  }
  async function onAvatarPicked(file: File) {
    const buf = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    try {
      await api.uploadAvatar(btoa(binary))
      await refresh()
      toast.show({ title: 'Avatar updated', variant: 'success' })
    } catch (err) {
      toast.show({ title: 'Failed', message: err instanceof Error ? err.message : undefined, variant: 'danger' })
    }
  }

  return (
    <>
      <Panel title="Public profile" description="Shown on your public profile page.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <Avatar name={user.name ?? user.username} size="lg" />
          <div style={{ display: 'grid', gap: 6 }}>
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              Upload new image
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onAvatarPicked(f)
                e.target.value = ''
              }}
            />
            <span style={{ fontSize: 'var(--ls-fs-label)', color: 'var(--ls-text-secondary)' }}>
              PNG, JPEG or WebP · max 512 KB
            </span>
          </div>
        </div>
        <div className="ds-stack">
          <Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Bio" value={bio} onChange={(e) => setBio(e.target.value)} />
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
          <Input
            label="Website URL"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            hint={`Your public profile: /users/${user.username}`}
          />
          <Button variant="primary" size="sm" onClick={() => void saveProfile()} disabled={busy()}>
            Save profile
          </Button>
        </div>
      </Panel>

      <Panel title="Username" description="Changing it breaks existing links that reference your old name.">
        <div className="ds-row">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} style={{ maxWidth: 280 }} />
          <Button size="sm" onClick={() => void saveUsername()} disabled={username === user.username}>
            Change username
          </Button>
        </div>
      </Panel>
    </>
  )
}

function busy(): boolean {
  return false // buttons are momentary; server errors surface via toasts
}

function PasswordPanel() {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [local, setLocal] = useState<string | null>(null)

  async function submit() {
    setLocal(null)
    if (next !== confirm) {
      setLocal('New passwords do not match')
      return
    }
    try {
      await api.changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      toast.show({ title: 'Password changed', message: 'Other sessions were signed out.', variant: 'success' })
    } catch (err) {
      toast.show({ title: 'Failed', message: err instanceof Error ? err.message : undefined, variant: 'danger' })
    }
  }

  return (
    <Panel title="Change password" description="All other sessions are signed out when your password changes.">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="ds-stack" style={{ maxWidth: 380 }}>
          <Input label="Current password" type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          <Input label="New password" type="password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
          <Input label="Confirm new password" type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {local && <p role="alert" style={{ fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-danger)' }}>{local}</p>}
          <Button type="submit" variant="primary" size="sm">Update password</Button>
        </div>
      </form>
    </Panel>
  )
}

function KeysPanel() {
  const toast = useToast()
  const [keys, setKeys] = useState<SshKey[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [keyText, setKeyText] = useState('')
  const [pendingDelete, setPendingDelete] = useState<SshKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function reload() {
    setKeys(await api.listKeys())
  }
  useEffect(() => {
    void reload().catch(() => setKeys([]))
  }, [])

  async function addKey() {
    setError(null)
    try {
      await api.addKey({ title, key: keyText })
      setAdding(false)
      setTitle('')
      setKeyText('')
      await reload()
      toast.show({ title: 'SSH key added', variant: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add key')
    }
  }

  return (
    <Panel title="SSH keys" description="Public keys used to authenticate Git over SSH. Paste the full openssh-format public key line.">
      {keys === null ? null : keys.length === 0 ? (
        <EmptyState icon="key" title="No SSH keys" description="Add a key to clone and push over SSH." action={<Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add SSH key</Button>} />
      ) : (
        <>
          <Table aria-label="SSH keys">
            <THead>
              <TR><TH>Title</TH><TH>Type</TH><TH>Fingerprint</TH><TH>Added</TH><TH /></TR>
            </THead>
            <TBody>
              {keys.map((k) => (
                <TR key={k.id}>
                  <TD>{k.title}</TD>
                  <TD>{k.key_type}{k.bits ? ` (${k.bits})` : ''}</TD>
                  <TD style={{ fontFamily: 'var(--ls-font-mono)', fontSize: 'var(--ls-fs-label)' }}>{k.fingerprint}</TD>
                  <TD>{new Date(k.created_at).toLocaleDateString()}</TD>
                  <TD>
                    <Button size="sm" variant="danger" onClick={() => setPendingDelete(k)}>Remove</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="ds-row">
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>Add SSH key</Button>
          </div>
        </>
      )}

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add SSH key"
        footer={
          <>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="primary" data-autofocus onClick={() => void addKey()}>Add key</Button>
          </>
        }
      >
        <div className="ds-stack">
          <Input label="Title" placeholder="work laptop" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            className="ls-textarea"
            rows={5}
            placeholder="ssh-ed25519 AAAA… user@host"
            value={keyText}
            onChange={(e) => setKeyText(e.target.value)}
            aria-label="Public key"
          />
          {error && <p role="alert" style={{ fontSize: 'var(--ls-fs-desc)', color: 'var(--ls-danger)' }}>{error}</p>}
        </div>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Remove SSH key?"
        description={`“${pendingDelete?.title ?? ''}” will lose access immediately.`}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              data-autofocus
              onClick={() => {
                if (pendingDelete) void api.deleteKey(pendingDelete.id).then(reload)
                setPendingDelete(null)
                toast.show({ title: 'Key removed', variant: 'info' })
              }}
            >
              Remove key
            </Button>
          </>
        }
      >
        <p>This cannot be undone. You can re-add the key at any time.</p>
      </Dialog>
    </Panel>
  )
}

const SCOPES = ['api', 'read_api', 'read_user', 'read_repository', 'write_repository'] as const

function TokensPanel() {
  const toast = useToast()
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<string>>(new Set(['read_api']))
  const [days, setDays] = useState(365)
  const [freshToken, setFreshToken] = useState<string | null>(null)

  async function reload() {
    setTokens(await api.listTokens())
  }
  useEffect(() => {
    void reload().catch(() => setTokens([]))
  }, [])

  function toggleScope(s: string) {
    setScopes((prev) => {
      const next = new Set(prev)
      next.has(s) ? next.delete(s) : next.add(s)
      return next
    })
  }

  async function create() {
    try {
      const created = await api.createToken({
        name,
        scopes: [...scopes],
        expires_in_days: Number(days),
      })
      setFreshToken(created.token)
      setName('')
      await reload()
    } catch (err) {
      toast.show({ title: 'Failed', message: err instanceof Error ? err.message : undefined, variant: 'danger' })
    }
  }

  return (
    <Panel title="Personal access tokens" description="Authenticate API requests and Git over HTTPS. The token is shown once after creation; only its SHA-256 digest is stored.">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <div className="ds-stack" style={{ maxWidth: 420 }}>
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-token" />
          <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend style={{ fontSize: 'var(--ls-fs-label)', color: 'var(--ls-text-secondary)', fontWeight: 500 }}>Scopes</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
              {SCOPES.map((s) => (
                <label key={s} className="ls-checkbox">
                  <input type="checkbox" checked={scopes.has(s)} onChange={() => toggleScope(s)} />
                  <code style={{ fontFamily: 'var(--ls-font-mono)', fontSize: 'var(--ls-fs-label)' }}>{s}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <Input
            label="Expiration (days)"
            type="number"
            min={1}
            max={365}
            required
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            hint="Tokens expire automatically (365 days maximum)."
          />
          <Button type="submit" variant="primary" size="sm" disabled={!name || scopes.size === 0}>
            Create token
          </Button>
        </div>
      </form>

      {freshToken && (
        <div role="alert" style={{ marginTop: 14, padding: 12, border: `1px solid var(--ls-success)`, borderRadius: 'var(--ls-radius-sm)', background: 'var(--ls-tint-success)' }}>
          <strong style={{ fontSize: 'var(--ls-fs-desc)' }}>Copy your token now — it will not be shown again.</strong>
          <pre style={{ fontFamily: 'var(--ls-font-mono)', fontSize: 'var(--ls-fs-label)', margin: '8px 0 0', whiteSpace: 'break-spaces', wordBreak: 'break-all' }}>{freshToken}</pre>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => setFreshToken(null)}>I saved it</Button>
          </div>
        </div>
      )}

      {tokens !== null && tokens.length > 0 && (
        <Table aria-label="Access tokens">
          <THead>
            <TR><TH>Name</TH><TH>Scopes</TH><TH>Expires</TH><TH>Last used</TH><TH>Status</TH><TH /></TR>
          </THead>
          <TBody>
            {tokens.map((t) => (
              <TR key={t.id}>
                <TD>{t.name}</TD>
                <TD>{t.scopes.join(', ')}</TD>
                <TD>{new Date(t.expires_at).toLocaleDateString()}</TD>
                <TD>{t.last_used_at ? new Date(t.last_used_at).toLocaleString() : '—'}</TD>
                <TD>{t.revoked_at ? <Badge variant="danger">revoked</Badge> : <Badge variant="success">active</Badge>}</TD>
                <TD>
                  {!t.revoked_at && (
                    <Button size="sm" variant="danger" onClick={() => void api.revokeToken(t.id).then(reload)}>
                      Revoke
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Panel>
  )
}

function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)

  async function reload() {
    setSessions(await api.listSessions())
  }
  useEffect(() => {
    void reload().catch(() => setSessions([]))
  }, [])

  return (
    <Panel title="Active sessions" description="Devices currently signed in to your account.">
      {sessions !== null && sessions.length > 0 && (
        <>
          <Table aria-label="Active sessions">
            <THead>
              <TR><TH>Device</TH><TH>Last active</TH><TH>Expires</TH><TH>Status</TH><TH /></TR>
            </THead>
            <TBody>
              {sessions.map((s) => (
                <TR key={s.id}>
                  <TD>{(s.user_agent ?? 'Unknown device').slice(0, 48)}</TD>
                  <TD>{new Date(s.last_active_at).toLocaleString()}</TD>
                  <TD>{new Date(s.expires_at).toLocaleString()}</TD>
                  <TD>{s.current ? <Badge variant="accent">this device</Badge> : <StatusIndicator status="neutral" label="other" />}</TD>
                  <TD>
                    {!s.current && (
                      <Button size="sm" variant="danger" onClick={() => void api.revokeSession(s.id).then(reload)}>
                        Revoke
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="ds-row">
            <Button size="sm" variant="danger" onClick={() => void api.revokeOtherSessions().then(reload)}>
              Sign out all other devices
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}

function AuditPanel() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  useEffect(() => {
    api.auditEvents().then(setEvents).catch(() => setEvents([]))
  }, [])

  return (
    <Panel title="Authentication audit trail" description="Security-relevant events on your account (last 50).">
      {events !== null && events.length > 0 && (
        <Table aria-label="Audit events">
          <THead>
            <TR><TH>Event</TH><TH>IP</TH><TH>When</TH></TR>
          </THead>
          <TBody>
            {events.map((e, i) => (
              <TR key={i}>
                <TD>{e.event}</TD>
                <TD>{e.ip ?? '—'}</TD>
                <TD>{new Date(e.created_at).toLocaleString()}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Panel>
  )
}

function AccountInner() {
  const { user } = useAuth()
  const [section, setSection] = useState('profile')
  if (!user) return null

  return (
    <>
      <div className="ls-page-title">
        <h1>Account settings</h1>
      </div>
      <p className="ls-page-desc">
        Signed in as @{user.username}
        {!user.email_verified && <> · email unverified</>}
      </p>
      <div className="ls-settings">
        <nav className="ls-settings__nav" aria-label="Settings sections">
          <div className="ls-sidebar__label">Settings</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="ls-navitem"
              aria-current={section === s.id ? 'true' : undefined}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="ls-settings__panel">
          {section === 'profile' && <ProfilePanel user={user} />}
          {section === 'password' && <PasswordPanel />}
          {section === 'keys' && <KeysPanel />}
          {section === 'tokens' && <TokensPanel />}
          {section === 'sessions' && <SessionsPanel />}
          {section === 'audit' && <AuditPanel />}
        </div>
      </div>
    </>
  )
}

export function AccountView() {
  return <AccountInner />
}
