import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { fieldErrors } from '../calendar/messages'
import type { EligibleTeacher } from './subjectsApi'
import { describeSubjectError } from './messages'

interface TeacherFormProps {
  /** "Assign a teacher" or "Replace Ama Mensah". */
  title: string
  submitLabel: string
  /** People who may be chosen: the caller removes teachers who are already assigned. */
  teachers: EligibleTeacher[]
  onSubmit: (teacherMembershipId: string) => Promise<void>
  onCancel: () => void
}

/** Pick a teacher from the school's active teachers. The server checks eligibility again when saving. */
export function TeacherForm({ title, submitLabel, teachers, onSubmit, onCancel }: TeacherFormProps) {
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [general, setGeneral] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setGeneral(null)
    if (!choice) { setError('Choose a teacher.'); return }
    setError(null)
    setBusy(true)
    try {
      await onSubmit(choice)
    } catch (e) {
      setError(fieldErrors(e).teacherMembershipId ?? null)
      setGeneral(describeSubjectError(e))
      setBusy(false)
    }
  }

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label={title}>
      <h3>{title}</h3>
      {teachers.length === 0 ? <p className="muted">There is no other active teacher to choose. Add a teacher on the Staff page first.</p> : null}
      <div className="field">
        <label htmlFor="teacher-choice">Teacher</label>
        <select id="teacher-choice" value={choice} onChange={(e) => setChoice(e.target.value)} aria-invalid={Boolean(error)} disabled={teachers.length === 0}>
          <option value="">Choose a teacher</option>
          {teachers.map((t) => <option key={t.membershipId} value={t.membershipId}>{t.fullName}</option>)}
        </select>
        {error ? <p className="field-error">{error}</p> : null}
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy || teachers.length === 0}>{busy ? 'Saving…' : submitLabel}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}
