import { useEffect, useState } from 'react'
import { api } from '../../auth/api'
import { useAuth, useHashRoute } from '../../auth/context'
import { AuthLayout, FieldError, SubmitButton, useAsyncSubmit } from './AuthLayout'
import { Input } from '../../design-system/Input'

export function LoginView() {
  const { refresh } = useAuth()
  const { navigate } = useHashRoute()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAsyncSubmit()

  async function submit() {
    await run(async () => {
      await api.login({ login, password })
      await refresh()
      navigate('/')
    })
  }

  return (
    <AuthLayout
      title="Sign in to LSGit"
      description="Use your username or email address."
      onSubmit={submit}
      busy={busy}
      footer={
        <>
          No account? <a href="#/register">Register</a> ·{' '}
          <a href="#/forgot">Forgot password?</a>
        </>
      }
    >
      <Input
        label="Username or email"
        autoComplete="username"
        required
        value={login}
        onChange={(e) => setLogin(e.target.value)}
      />
      <Input
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <FieldError message={error} />
      <SubmitButton label="Sign in" busy={busy} />
    </AuthLayout>
  )
}

export function RegisterView() {
  const { refresh } = useAuth()
  const { navigate } = useHashRoute()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useAsyncSubmit()

  async function submit() {
    await run(async () => {
      await api.register({ username, email, name: name || undefined, password })
      await refresh()
      navigate('/')
    })
  }

  return (
    <AuthLayout
      title="Create your account"
      description="The first account on an instance becomes its administrator."
      onSubmit={submit}
      busy={busy}
      footer={
        <>
          Already registered? <a href="#/login">Sign in</a>
        </>
      }
    >
      <Input label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      <Input
        label="Username"
        required
        hint="Letters, digits, '.', '_' or '-'. Used in URLs and for sign-in."
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        label="Password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        hint="At least 10 characters. Must not contain your username or email."
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <FieldError message={error} />
      <SubmitButton label="Create account" busy={busy} />
    </AuthLayout>
  )
}

export function ForgotView() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const { busy, error, run } = useAsyncSubmit()

  async function submit() {
    await run(async () => {
      await api.requestPasswordReset(email)
      setSent(true)
    })
  }

  if (sent) {
    return (
      <AuthLayout title="Check your inbox" description="If that account exists, a reset link has been sent. The link expires after a few hours." >
        <a href="#/login">Back to sign in</a>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="We will email you a single-use reset link."
      onSubmit={submit}
      busy={busy}
      footer={<a href="#/login">Back to sign in</a>}
    >
      <Input
        label="Email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <FieldError message={error} />
      <SubmitButton label="Send reset link" busy={busy} />
    </AuthLayout>
  )
}

export function ResetView({ token }: { token: string }) {
  const { navigate } = useHashRoute()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const { busy, error, run } = useAsyncSubmit()

  async function submit() {
    setLocalError(null)
    if (password !== confirm) {
      setLocalError('Passwords do not match')
      return
    }
    await run(async () => {
      await api.resetPassword(token, password)
      navigate('/login')
    })
  }

  return (
    <AuthLayout title="Choose a new password" onSubmit={submit} busy={busy}>
      <Input
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        minLength={10}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Input
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      <FieldError message={localError ?? error} />
      <SubmitButton label="Reset password" busy={busy} />
    </AuthLayout>
  )
}

export function VerifyEmailView({ token }: { token: string }) {
  const [result, setResult] = useState<'pending' | 'ok' | 'fail'>('pending')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .verifyEmail(token)
      .then(() => !cancelled && setResult('ok'))
      .catch((err: unknown) => {
        if (cancelled) return
        setResult('fail')
        setMessage(err instanceof Error ? err.message : 'Verification failed')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  return (
    <AuthLayout
      title={result === 'ok' ? 'Email verified' : result === 'fail' ? 'Verification failed' : 'Verifying…'}
      description={result === 'ok' ? 'Your email address is confirmed.' : result === 'fail' ? message : undefined}
    >
      <a href="#/">Go to LSGit</a>
    </AuthLayout>
  )
}
