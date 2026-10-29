import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { ChangePasswordScreen } from './ChangePasswordScreen'
import { useAuth } from './AuthContext'
import { SchoolPicker } from './SchoolPicker'

/** Gate for every page inside the app: loading -> error -> signed out -> choose school -> page. */
export function ProtectedRoute() {
  const { status, me, reload } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="auth-screen" role="status" aria-live="polite">
        <p>Checking your session…</p>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Can't reach the server</h1>
          <p>The app couldn't check your session. Check your connection and try again.</p>
          <Button variant="primary" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }
  if (status === 'signedOut' || !me) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  // A temporary password must be replaced before anything else; the server refuses every other call until then.
  if (me.mustChangePassword) return <ChangePasswordScreen />
  if (!me.school) return <SchoolPicker />
  return <Outlet />
}
