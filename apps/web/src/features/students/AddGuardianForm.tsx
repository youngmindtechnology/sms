import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { fieldErrors } from '../calendar/messages'
import { describeStudentError } from './messages'
import { RELATIONSHIPS, linkGuardian, searchGuardians } from './studentsApi'
import type { Guardian, GuardianLink, GuardianRelationship } from './studentsApi'

interface Props {
  studentId: string
  /** Guardians already linked to this student, so they can't be picked twice. */
  linked: GuardianLink[]
  isFirst: boolean
  onDone: () => Promise<void>
  onCancel: () => void
}

/** Link an existing guardian (found by name or phone, e.g. a sibling's parent) or add a new one. */
export function AddGuardianForm({ studentId, linked, isFirst, onDone, onCancel }: Props) {
  const [mode, setMode] = useState<'existing' | 'new'>('new')
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<Guardian[] | null>(null)
  const [picked, setPicked] = useState<string>('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [relationship, setRelationship] = useState<GuardianRelationship | ''>('')
  const [primary, setPrimary] = useState(isFirst)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  async function search() {
    setGeneral(null)
    if (term.trim().length < 2) { setErrors({ search: 'Type at least 2 characters.' }); return }
    setErrors({})
    setBusy(true)
    try {
      setResults(await searchGuardians(term.trim()))
      setPicked('')
    } catch (error) {
      setGeneral(describeStudentError(error))
    }
    setBusy(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const local: Record<string, string> = {}
    if (!relationship) local.relationship = 'Choose the relationship.'
    if (mode === 'existing' && !picked) local.guardianId = 'Search and choose a guardian.'
    if (mode === 'new') {
      if (!fullName.trim()) local['guardian.fullName'] = "Enter the guardian's full name."
      if (!phone.trim() && !email.trim()) local['guardian.phone'] = 'Enter a phone number or an email address.'
    }
    setErrors(local)
    setGeneral(null)
    if (Object.keys(local).length || !relationship) return

    setBusy(true)
    try {
      await linkGuardian(
        studentId,
        mode === 'existing'
          ? { guardianId: picked, relationship, isPrimaryContact: primary }
          : { guardian: { fullName: fullName.trim(), phone: phone.trim() || null, email: email.trim() || null }, relationship, isPrimaryContact: primary },
      )
      await onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeStudentError(error))
      setBusy(false)
    }
  }

  const alreadyLinked = new Set(linked.map((g) => g.id))

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label="Add guardian">
      <h3>Add a guardian</h3>
      <div className="segmented" role="group" aria-label="Guardian type">
        <Button variant={mode === 'new' ? 'primary' : 'secondary'} aria-pressed={mode === 'new'} onClick={() => setMode('new')}>New guardian</Button>
        <Button variant={mode === 'existing' ? 'primary' : 'secondary'} aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>Existing guardian</Button>
      </div>

      {mode === 'existing' ? (
        <div className="stack">
          <div className="field">
            <label htmlFor="guardian-search">Search by name or phone</label>
            <div className="inline-row">
              <input id="guardian-search" value={term} maxLength={100} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search() } }} aria-invalid={Boolean(errors.search)} />
              <Button onClick={() => void search()} disabled={busy}>Search</Button>
            </div>
            {errors.search ? <p className="field-error">{errors.search}</p> : null}
          </div>
          {results && results.length === 0 ? <p className="muted">No guardian found. Try another spelling, or add a new guardian.</p> : null}
          {results && results.length > 0 ? (
            <fieldset className="choice-list">
              <legend className="sr-only">Matching guardians</legend>
              {results.map((g) => (
                <label key={g.id} className="choice">
                  <input type="radio" name="guardian-pick" value={g.id} checked={picked === g.id} disabled={alreadyLinked.has(g.id)} onChange={() => setPicked(g.id)} />
                  <span>{g.fullName}<span className="muted-inline"> · {g.phone ?? g.email ?? 'no contact'}{alreadyLinked.has(g.id) ? ' · already linked' : ''}</span></span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {errors.guardianId ? <p className="field-error">{errors.guardianId}</p> : null}
        </div>
      ) : (
        <div className="period-form__grid">
          <div className="field">
            <label htmlFor="g-name">Full name</label>
            <input id="g-name" value={fullName} maxLength={200} onChange={(e) => setFullName(e.target.value)} aria-invalid={Boolean(errors['guardian.fullName'])} />
            {errors['guardian.fullName'] ? <p className="field-error">{errors['guardian.fullName']}</p> : null}
          </div>
          <div className="field">
            <label htmlFor="g-phone">Phone</label>
            <input id="g-phone" inputMode="tel" value={phone} maxLength={30} placeholder="024 123 4567" onChange={(e) => setPhone(e.target.value)} aria-invalid={Boolean(errors['guardian.phone'])} />
            {errors['guardian.phone'] ? <p className="field-error">{errors['guardian.phone']}</p> : null}
          </div>
          <div className="field">
            <label htmlFor="g-email">Email (optional)</label>
            <input id="g-email" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(errors['guardian.email'])} />
            {errors['guardian.email'] ? <p className="field-error">{errors['guardian.email']}</p> : null}
          </div>
        </div>
      )}

      <div className="period-form__grid">
        <div className="field">
          <label htmlFor="g-relationship">Relationship to the student</label>
          <select id="g-relationship" value={relationship} onChange={(e) => setRelationship(e.target.value as GuardianRelationship | '')} aria-invalid={Boolean(errors.relationship)}>
            <option value="">Choose a relationship</option>
            {RELATIONSHIPS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {errors.relationship ? <p className="field-error">{errors.relationship}</p> : null}
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} /> Main contact for this student</label>
      {errors.isPrimaryContact ? <p className="field-error">{errors.isPrimaryContact}</p> : null}

      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Add guardian'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}
