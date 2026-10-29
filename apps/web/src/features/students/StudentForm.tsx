import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '../../components/ui/Button'
import { fieldErrors } from '../calendar/messages'
import type { Student, StudentInput } from './studentsApi'
import { describeStudentError } from './messages'

interface StudentFormProps {
  initial?: Student
  onSubmit: (values: StudentInput) => Promise<void>
  onCancel: () => void
}

/** Register or edit a student. Only what a school needs: names, date of birth, admission details. */
export function StudentForm({ initial, onSubmit, onCancel }: StudentFormProps) {
  const [admissionNumber, setAdmissionNumber] = useState(initial?.admissionNumber ?? '')
  const [firstName, setFirstName] = useState(initial?.firstName ?? '')
  const [middleName, setMiddleName] = useState(initial?.middleName ?? '')
  const [lastName, setLastName] = useState(initial?.lastName ?? '')
  const [dateOfBirth, setDateOfBirth] = useState(initial?.dateOfBirth ?? '')
  const [admittedOn, setAdmittedOn] = useState(initial?.admittedOn ?? '')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const local: Record<string, string> = {}
    if (!firstName.trim()) local.firstName = 'Enter the first name.'
    if (!lastName.trim()) local.lastName = 'Enter the last name.'
    if (initial && !admissionNumber.trim()) local.admissionNumber = 'Enter the admission number.'
    setErrors(local)
    setGeneral(null)
    if (Object.keys(local).length) return

    setBusy(true)
    try {
      await onSubmit({
        ...(admissionNumber.trim() ? { admissionNumber: admissionNumber.trim() } : {}),
        firstName: firstName.trim(),
        middleName: middleName.trim() || null,
        lastName: lastName.trim(),
        dateOfBirth: dateOfBirth || null,
        admittedOn: admittedOn || null,
      })
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeStudentError(error))
      setBusy(false)
    }
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, options: { type?: string; hint?: string; maxLength?: number; placeholder?: string } = {}) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={options.type ?? 'text'} value={value} maxLength={options.maxLength} placeholder={options.placeholder} onChange={(e) => set(e.target.value)} aria-invalid={Boolean(errors[id])} aria-describedby={options.hint ? `${id}-hint` : undefined} />
      {options.hint ? <p className="field-hint" id={`${id}-hint`}>{options.hint}</p> : null}
      {errors[id] ? <p className="field-error">{errors[id]}</p> : null}
    </div>
  )

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label={initial ? 'Edit student' : 'Register student'}>
      <h3>{initial ? 'Edit student' : 'Register a student'}</h3>
      <div className="period-form__grid">
        {field('firstName', 'First name', firstName, setFirstName, { maxLength: 100 })}
        {field('middleName', 'Middle name (optional)', middleName, setMiddleName, { maxLength: 100 })}
        {field('lastName', 'Last name', lastName, setLastName, { maxLength: 100 })}
        {field('admissionNumber', initial ? 'Admission number' : 'Admission number (optional)', admissionNumber, setAdmissionNumber, {
          maxLength: 40, placeholder: 'e.g. 2026/0001', hint: initial ? undefined : 'Leave empty and the system will create the next number.',
        })}
        {field('dateOfBirth', 'Date of birth (optional)', dateOfBirth, setDateOfBirth, { type: 'date' })}
        {field('admittedOn', 'Admission date (optional)', admittedOn, setAdmittedOn, { type: 'date' })}
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save changes' : 'Register student'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}
