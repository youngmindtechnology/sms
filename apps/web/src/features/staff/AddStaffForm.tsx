import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { fieldErrors } from '../calendar/messages'
import { describeStaffError } from './messages'
import { ROLE_LABELS } from './staffApi'
import type { NewStaff, StaffRole } from './staffApi'

interface Props {
  assignableRoles: StaffRole[]
  onSubmit: (values: NewStaff) => Promise<void>
  onCancel: () => void
}

/** New account for this school. Only the roles the signed-in person may give are offered. */
export function AddStaffForm({ assignableRoles, onSubmit, onCancel }: Props) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [roles, setRoles] = useState<StaffRole[]>([])
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  function toggle(role: StaffRole) {
    setRoles((current) => (current.includes(role) ? current.filter((r) => r !== role) : [...current, role]))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setErrors({})
    setFormError(null)
    try {
      await onSubmit({ fullName: fullName.trim(), email: email.trim(), roles })
    } catch (error) {
      const fields = fieldErrors(error)
      setErrors(fields)
      if (Object.keys(fields).length === 0) setFormError(describeStaffError(error))
      setBusy(false)
    }
  }

  return (
    <form className="period-form" onSubmit={submit} noValidate>
      <h3>Add a staff member</h3>
      <p className="muted">They get a one-time password to sign in with. They must choose their own password the first time.</p>
      <div className="period-form__grid">
        <div className="field">
          <label htmlFor="staff-name">Full name</label>
          <input id="staff-name" value={fullName} maxLength={200} onChange={(e) => setFullName(e.target.value)} aria-invalid={Boolean(errors.fullName)} />
          {errors.fullName ? <p className="field-error">{errors.fullName}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="staff-email">Email</label>
          <input id="staff-email" type="email" autoComplete="off" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(errors.email)} />
          {errors.email ? <p className="field-error">{errors.email}</p> : null}
        </div>
      </div>
      <fieldset className="role-fieldset">
        <legend>Roles</legend>
        {assignableRoles.map((role) => (
          <label key={role} className="check">
            <input type="checkbox" checked={roles.includes(role)} onChange={() => toggle(role)} /> {ROLE_LABELS[role]}
          </label>
        ))}
        {errors.roles ? <p className="field-error">{errors.roles}</p> : null}
      </fieldset>
      {formError ? <p className="form-error" role="alert">{formError}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy || !fullName.trim() || !email.trim() || roles.length === 0}>{busy ? 'Creating…' : 'Create account'}</Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}
