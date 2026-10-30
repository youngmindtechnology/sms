import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { fieldErrors } from '../calendar/messages'
import type { Subject, SubjectInput } from './subjectsApi'
import { describeSubjectError } from './messages'

interface SubjectFormProps {
  className: string
  initial?: Subject
  onSubmit: (values: SubjectInput) => Promise<void>
  onCancel: () => void
}

/** Create or edit a subject. The server decides what is valid; this only catches obvious slips early. */
export function SubjectForm({ className, initial, onSubmit, onCancel }: SubjectFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [code, setCode] = useState(initial?.code ?? '')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const local: Record<string, string> = {}
    if (!name.trim()) local.name = 'Enter a subject name.'
    if (code.trim().length > 20) local.code = 'The code can have at most 20 characters.'
    setErrors(local)
    setGeneral(null)
    if (Object.keys(local).length) return

    setBusy(true)
    try {
      await onSubmit({ name: name.trim(), code: code.trim() })
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeSubjectError(error))
      setBusy(false)
    }
  }

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label={initial ? 'Edit subject' : 'New subject'}>
      <h3>{initial ? `Edit ${initial.name}` : `New subject for ${className}`}</h3>
      <div className="period-form__grid">
        <div className="field">
          <label htmlFor="subject-name">Subject name</label>
          <input id="subject-name" value={name} maxLength={100} placeholder="e.g. Mathematics" onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} />
          {errors.name ? <p className="field-error">{errors.name}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="subject-code">Code (optional)</label>
          <input id="subject-code" value={code} maxLength={20} placeholder="e.g. MATH" onChange={(e) => setCode(e.target.value)} aria-invalid={Boolean(errors.code)} />
          {errors.code ? <p className="field-error">{errors.code}</p> : null}
        </div>
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Create subject'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}
