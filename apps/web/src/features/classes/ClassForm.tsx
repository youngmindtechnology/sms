import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { fieldErrors } from '../calendar/messages'
import { CLASS_LEVELS } from './classesApi'
import type { ClassInput, ClassLevel, SchoolClass } from './classesApi'
import { describeClassError } from './messages'

interface ClassFormProps {
  initial?: SchoolClass
  onSubmit: (values: ClassInput) => Promise<void>
  onCancel: () => void
}

/** Create or edit a class. The server decides what is valid; this only catches obvious slips early. */
export function ClassForm({ initial, onSubmit, onCancel }: ClassFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [level, setLevel] = useState<ClassLevel | ''>(initial?.level ?? '')
  const [order, setOrder] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const local: Record<string, string> = {}
    if (!name.trim()) local.name = 'Enter a class name.'
    if (!level) local.level = 'Choose a level.'
    if (!initial && order !== '' && !/^\d{1,5}$/.test(order)) local.sortOrder = 'Use a whole number, or leave it empty to add the class at the end.'
    setErrors(local)
    setGeneral(null)
    if (Object.keys(local).length || !level) return

    setBusy(true)
    try {
      await onSubmit({ name: name.trim(), level, ...(!initial && order !== '' ? { sortOrder: Number(order) } : {}) })
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeClassError(error))
      setBusy(false)
    }
  }

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label={initial ? 'Edit class' : 'New class'}>
      <h3>{initial ? 'Edit class' : 'New class'}</h3>
      <div className="period-form__grid">
        <div className="field">
          <label htmlFor="class-name">Class name</label>
          <input id="class-name" value={name} maxLength={100} placeholder="e.g. Basic 1A" onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} />
          {errors.name ? <p className="field-error">{errors.name}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="class-level">Level</label>
          <select id="class-level" value={level} onChange={(e) => setLevel(e.target.value as ClassLevel | '')} aria-invalid={Boolean(errors.level)}>
            <option value="">Choose a level</option>
            {CLASS_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          {errors.level ? <p className="field-error">{errors.level}</p> : null}
        </div>
        {!initial ? (
          <div className="field">
            <label htmlFor="class-order">Display order (optional)</label>
            <input id="class-order" inputMode="numeric" value={order} maxLength={5} onChange={(e) => setOrder(e.target.value)} aria-invalid={Boolean(errors.sortOrder)} />
            {errors.sortOrder ? <p className="field-error">{errors.sortOrder}</p> : null}
          </div>
        ) : null}
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Create class'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}
