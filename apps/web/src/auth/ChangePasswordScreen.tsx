import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { ApiError } from '../lib/api'
import { useAuth } from './AuthContext'

const MIN_LENGTH = 12

/**
 * Shown instead of the app while the account still has a temporary password (a new account, or a
 * password reset by an administrator). Nothing else works until the person chooses their own.
 */
export function ChangePasswordScreen() {
  const { me, changePassword, logout } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (next.length < MIN_LENGTH) return setError(`Your new password must be at least ${MIN_LENGTH} characters.`)
    if (next !== again) return setError("The two new passwords don't match.")
    if (next === current) return setError('Choose a password different from the temporary one.')
    setBusy(true)
    try {
      await changePassword(current, next)
      // The server now reports no pending change, so the app takes over from here.
    } catch (e) {
      setCurrent('')
      if (e instanceof ApiError && e.code === 'wrong_password') setError('The temporary password is incorrect.')
      else if (e instanceof ApiError && e.code === 'weak_password') setError('Choose a longer, less common password that does not contain your email name.')
      else if (e instanceof ApiError && e.status === 429) setError('Too many attempts. Please wait a few minutes and try again.')
      else if (e instanceof ApiError && e.status === 0) setError("Can't reach the server. Check your connection and try again.")
      else setError('The password could not be changed. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <p className="auth-brand">YMT School Management</p>
        <h1>Choose your password</h1>
        <p>{me ? `Welcome, ${me.user.fullName}. ` : ''}You signed in with a temporary password. Choose your own to continue.</p>

        <label htmlFor="cp-current">Temporary password</label>
        <input id="cp-current" type="password" autoComplete="current-password" required maxLength={1024} value={current} onChange={(e) => setCurrent(e.target.value)} />

        <label htmlFor="cp-new">New password</label>
        <input id="cp-new" type="password" autoComplete="new-password" required maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="cp-hint" />
        <p id="cp-hint" className="auth-note">At least {MIN_LENGTH} characters. A few random words work well.</p>

        <label htmlFor="cp-again">New password again</label>
        <input id="cp-again" type="password" autoComplete="new-password" required maxLength={128} value={again} onChange={(e) => setAgain(e.target.value)} />

        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <Button type="submit" variant="primary" disabled={busy || !current || !next || !again}>
          {busy ? 'Saving…' : 'Save password'}
        </Button>
        <Button onClick={() => void logout()} disabled={busy}>Sign out</Button>
      </form>
    </div>
  )
}
