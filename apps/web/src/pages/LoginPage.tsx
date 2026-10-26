import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Button } from '../components/ui/Button'
import { ApiError } from '../lib/api'

export function LoginPage() {
  const { status, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from
  const destination = from && from.startsWith('/') && !from.startsWith('//') && from !== '/login' ? from : '/'

  if (status === 'signedIn') return <Navigate to={destination} replace />

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await login(email, password)
      setPassword('')
      navigate(destination, { replace: true })
    } catch (e) {
      setPassword('')
      if (e instanceof ApiError && e.status === 401) setError('Email or password is incorrect.')
      else if (e instanceof ApiError && e.status === 429) setError('Too many attempts. Please wait a few minutes and try again.')
      else if (e instanceof ApiError && e.status === 0) setError("Can't reach the server. Check your connection and try again.")
      else setError('Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <p className="auth-brand">YMT School Management</p>
        <h1>Sign in</h1>

        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />

        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} />

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="auth-note">Accounts are created by your school's administrator. There is no public sign-up.</p>
      </form>
    </div>
  )
}
