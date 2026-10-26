import { useState } from 'react'
import { Button } from '../components/ui/Button'
import { useAuth } from './AuthContext'

/** Shown when the user belongs to several schools (or none) and none is selected yet. */
export function SchoolPicker() {
  const { me, switchSchool, logout } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const schools = me?.schools ?? []

  async function choose(id: string) {
    setBusy(id)
    setError(false)
    try {
      await switchSchool(id)
    } catch {
      setError(true)
      setBusy(null)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        {schools.length === 0 ? (
          <>
            <h1>No school access</h1>
            <p>Your account isn't linked to an active school. Ask your school's owner or administrator to give you access.</p>
          </>
        ) : (
          <>
            <h1>Choose a school</h1>
            <ul className="school-list">
              {schools.map((s) => (
                <li key={s.schoolId}>
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void choose(s.schoolId)}>
                    {s.schoolName}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error ? (
          <p className="form-error" role="alert">
            That school couldn't be opened. Try again.
          </p>
        ) : null}
        <Button variant="ghost" onClick={() => void logout()}>
          Sign out
        </Button>
      </div>
    </div>
  )
}
