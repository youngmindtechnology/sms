import { useState } from 'react'
import type { FormEvent } from 'react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { fieldErrors } from '../calendar/messages'
import { AddGuardianForm } from './AddGuardianForm'
import { describeStudentError } from './messages'
import { RELATIONSHIPS, relationshipLabel, unlinkGuardian, updateGuardian, updateGuardianLink } from './studentsApi'
import type { GuardianLink, GuardianRelationship } from './studentsApi'

interface Props {
  studentId: string
  guardians: GuardianLink[]
  canWrite: boolean
  onChanged: () => Promise<void>
  onNotice: (notice: { kind: 'success' | 'error'; text: string }) => void
}

function EditGuardian({ item, studentId, onSaved, onCancel }: { item: GuardianLink; studentId: string; onSaved: () => Promise<void>; onCancel: () => void }) {
  const [fullName, setFullName] = useState(item.fullName)
  const [phone, setPhone] = useState(item.phone ?? '')
  const [email, setEmail] = useState(item.email ?? '')
  const [relationship, setRelationship] = useState<GuardianRelationship>(item.relationship)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!fullName.trim()) { setErrors({ fullName: "Enter the guardian's full name." }); return }
    setBusy(true)
    setErrors({})
    setGeneral(null)
    try {
      await updateGuardian(item.id, { fullName: fullName.trim(), phone: phone.trim() || null, email: email.trim() || null })
      if (relationship !== item.relationship) await updateGuardianLink(studentId, item.id, { relationship })
      await onSaved()
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeStudentError(error))
      setBusy(false)
    }
  }

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label={`Edit ${item.fullName}`}>
      <h3>Edit guardian</h3>
      <p className="muted">Name, phone and email belong to the guardian and show for all of their children. The relationship applies to this student only.</p>
      <div className="period-form__grid">
        <div className="field">
          <label htmlFor={`eg-name-${item.id}`}>Full name</label>
          <input id={`eg-name-${item.id}`} value={fullName} maxLength={200} onChange={(e) => setFullName(e.target.value)} aria-invalid={Boolean(errors.fullName)} />
          {errors.fullName ? <p className="field-error">{errors.fullName}</p> : null}
        </div>
        <div className="field">
          <label htmlFor={`eg-phone-${item.id}`}>Phone</label>
          <input id={`eg-phone-${item.id}`} inputMode="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} aria-invalid={Boolean(errors.phone)} />
          {errors.phone ? <p className="field-error">{errors.phone}</p> : null}
        </div>
        <div className="field">
          <label htmlFor={`eg-email-${item.id}`}>Email</label>
          <input id={`eg-email-${item.id}`} type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(errors.email)} />
          {errors.email ? <p className="field-error">{errors.email}</p> : null}
        </div>
        <div className="field">
          <label htmlFor={`eg-rel-${item.id}`}>Relationship</label>
          <select id={`eg-rel-${item.id}`} value={relationship} onChange={(e) => setRelationship(e.target.value as GuardianRelationship)}>
            {RELATIONSHIPS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}

/** Guardians linked to one student. Removing a guardian only removes the link; the guardian record stays. */
export function GuardianSection({ studentId, guardians, canWrite, onChanged, onNotice }: Props) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<GuardianLink | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function run(id: string, work: () => Promise<void>, success: string) {
    setBusyId(id)
    try {
      await work()
      onNotice({ kind: 'success', text: success })
      await onChanged()
    } catch (error) {
      onNotice({ kind: 'error', text: describeStudentError(error) })
    }
    setBusyId(null)
  }

  return (
    <div className="stack">
      {canWrite && !adding ? <div><Button variant="primary" onClick={() => setAdding(true)}>Add guardian</Button></div> : null}
      {adding ? (
        <AddGuardianForm
          studentId={studentId}
          linked={guardians}
          isFirst={guardians.length === 0}
          onDone={async () => { setAdding(false); onNotice({ kind: 'success', text: 'Guardian added.' }); await onChanged() }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      {confirming ? (
        <div className="confirm-bar" role="alertdialog" aria-label="Confirm remove guardian">
          <p className="confirm-bar__title">Remove {confirming.fullName} from this student?</p>
          <p>Only the link is removed. {confirming.fullName} stays in the school's records and any other children stay linked. The removal is written to the audit trail.</p>
          <div className="period-item__actions">
            <Button variant="primary" disabled={busyId !== null} onClick={() => { const g = confirming; setConfirming(null); void run(g.id, () => unlinkGuardian(studentId, g.id).then(() => undefined), `${g.fullName} was removed from this student.`) }}>Remove guardian</Button>
            <Button variant="ghost" onClick={() => setConfirming(null)}>Keep</Button>
          </div>
        </div>
      ) : null}

      {guardians.length === 0 && !adding ? (
        <EmptyState title="No guardians yet" description={canWrite ? 'Add a parent or guardian so the school can reach the family.' : 'No guardian has been recorded for this student.'} />
      ) : null}

      <ul className="period-list">
        {guardians.map((g) => (
          <li key={g.id} className="guardian-item">
            {editing === g.id ? (
              <EditGuardian item={g} studentId={studentId} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); onNotice({ kind: 'success', text: 'Guardian updated.' }); await onChanged() }} />
            ) : (
              <>
                <div className="guardian-item__main">
                  <span className="period-item__name">{g.fullName}</span>
                  <span className="period-item__dates">
                    {relationshipLabel(g.relationship)}
                    {g.phone ? ` · ${g.phone}` : ''}
                    {g.email ? ` · ${g.email}` : ''}
                  </span>
                </div>
                {g.isPrimaryContact ? <Badge variant="active">Main contact</Badge> : null}
                {canWrite ? (
                  <div className="period-item__actions">
                    {!g.isPrimaryContact ? <Button disabled={busyId !== null} onClick={() => void run(g.id, () => updateGuardianLink(studentId, g.id, { isPrimaryContact: true }).then(() => undefined), `${g.fullName} is now the main contact.`)}>Make main contact</Button> : null}
                    <Button disabled={busyId !== null} onClick={() => setEditing(g.id)}>Edit</Button>
                    <Button disabled={busyId !== null} onClick={() => setConfirming(g)}>Remove</Button>
                  </div>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
