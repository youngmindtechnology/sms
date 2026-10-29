import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { formatDate } from '../../lib/format'
import { listYears } from '../calendar/calendarApi'
import type { AcademicYear } from '../calendar/calendarApi'
import { fieldErrors } from '../calendar/messages'
import { listClasses } from '../classes/classesApi'
import type { SchoolClass } from '../classes/classesApi'
import { describeStudentError } from './messages'
import { enrollmentLabel, enrollStudent, transferStudent } from './studentsApi'
import type { Enrollment, StudentStatus } from './studentsApi'

interface Props {
  studentId: string
  studentStatus: StudentStatus
  enrollments: Enrollment[]
  current: Enrollment | null
  canWrite: boolean
  onChanged: () => Promise<void>
  onNotice: (notice: { kind: 'success' | 'error'; text: string }) => void
}

type Options = { state: 'loading' } | { state: 'error' } | { state: 'ready'; classes: SchoolClass[]; years: AcademicYear[] }

/** Classes and years are only needed (and only requested) by people who can enroll. */
function useOptions(enabled: boolean): Options {
  const [options, setOptions] = useState<Options>({ state: 'loading' })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    Promise.all([listClasses(controller.signal), listYears(controller.signal)])
      .then(([classes, years]) => setOptions({ state: 'ready', classes, years }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setOptions({ state: 'error' })
      })
    return () => controller.abort()
  }, [enabled])
  return options
}

function EnrollForm({ studentId, classes, years, onDone, onCancel }: { studentId: string; classes: SchoolClass[]; years: AcademicYear[]; onDone: () => Promise<void>; onCancel: () => void }) {
  const openYears = years.filter((y) => y.status !== 'CLOSED')
  const activeClasses = classes.filter((c) => c.isActive)
  const [classId, setClassId] = useState('')
  const [yearId, setYearId] = useState(openYears.find((y) => y.status === 'ACTIVE')?.id ?? openYears[0]?.id ?? '')
  const [startDate, setStartDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const local: Record<string, string> = {}
    if (!classId) local.classId = 'Choose a class.'
    if (!yearId) local.academicYearId = 'Choose an academic year.'
    setErrors(local)
    setGeneral(null)
    if (Object.keys(local).length) return
    setBusy(true)
    try {
      await enrollStudent(studentId, { classId, academicYearId: yearId, ...(startDate ? { startDate } : {}) })
      await onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeStudentError(error))
      setBusy(false)
    }
  }

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label="Enroll student">
      <h3>Enroll in a class</h3>
      {openYears.length === 0 ? <p className="form-error">There is no open academic year. Add one under Academic Calendar first.</p> : null}
      {activeClasses.length === 0 ? <p className="form-error">There is no active class. Add one under Classes first.</p> : null}
      <div className="period-form__grid">
        <div className="field">
          <label htmlFor="enroll-year">Academic year</label>
          <select id="enroll-year" value={yearId} onChange={(e) => setYearId(e.target.value)} aria-invalid={Boolean(errors.academicYearId)}>
            <option value="">Choose a year</option>
            {openYears.map((y) => <option key={y.id} value={y.id}>{y.name}{y.status === 'ACTIVE' ? ' (current)' : ''}</option>)}
          </select>
          {errors.academicYearId ? <p className="field-error">{errors.academicYearId}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="enroll-class">Class</label>
          <select id="enroll-class" value={classId} onChange={(e) => setClassId(e.target.value)} aria-invalid={Boolean(errors.classId)}>
            <option value="">Choose a class</option>
            {activeClasses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {errors.classId ? <p className="field-error">{errors.classId}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="enroll-start">Start date (optional)</label>
          <input id="enroll-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-invalid={Boolean(errors.startDate)} />
          <p className="field-hint">Leave empty to start today, or at the start of the year if it hasn't begun. After an earlier enrollment ended, the start is the day after it ended.</p>
          {errors.startDate ? <p className="field-error">{errors.startDate}</p> : null}
        </div>
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Enroll student'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}

function TransferForm({ studentId, current, classes, onDone, onCancel }: { studentId: string; current: Enrollment; classes: SchoolClass[]; onDone: () => Promise<void>; onCancel: () => void }) {
  const choices = classes.filter((c) => c.isActive && c.id !== current.classId)
  const [classId, setClassId] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!classId) { setErrors({ classId: 'Choose the new class.' }); return }
    setErrors({})
    setGeneral(null)
    setBusy(true)
    try {
      await transferStudent(studentId, { classId, ...(effectiveDate ? { effectiveDate } : {}) })
      await onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeStudentError(error))
      setBusy(false)
    }
  }

  return (
    <form className="period-form" onSubmit={submit} noValidate aria-label="Change class">
      <h3>Change class</h3>
      <p className="muted">The student leaves {current.className} the day before the change and joins the new class on the date below. The {current.className} record is kept in the history.</p>
      <div className="period-form__grid">
        <div className="field">
          <label htmlFor="transfer-class">New class</label>
          <select id="transfer-class" value={classId} onChange={(e) => setClassId(e.target.value)} aria-invalid={Boolean(errors.classId)}>
            <option value="">Choose a class</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {errors.classId ? <p className="field-error">{errors.classId}</p> : null}
        </div>
        <div className="field">
          <label htmlFor="transfer-date">Change takes effect (optional)</label>
          <input id="transfer-date" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} aria-invalid={Boolean(errors.effectiveDate)} />
          <p className="field-hint">Leave empty for today. It must be after the student joined {current.className}.</p>
          {errors.effectiveDate ? <p className="field-error">{errors.effectiveDate}</p> : null}
        </div>
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div className="period-form__actions">
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Change class'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  )
}

/** Current class, the history of earlier classes, and (for people who can write) enrolling and changing class. */
export function EnrollmentSection({ studentId, studentStatus, enrollments, current, canWrite, onChanged, onNotice }: Props) {
  const [mode, setMode] = useState<'none' | 'enroll' | 'transfer'>('none')
  const options = useOptions(canWrite)
  const active = studentStatus === 'ACTIVE'
  const history = enrollments.filter((e) => e.id !== current?.id)

  async function done(text: string) {
    setMode('none')
    onNotice({ kind: 'success', text })
    await onChanged()
  }

  return (
    <div className="stack">
      {current ? (
        <div className="current-class">
          <p className="muted">Current class</p>
          <p className="current-class__name">{current.className}</p>
          <p className="muted">{current.academicYearName} · since {formatDate(current.startDate)}</p>
        </div>
      ) : (
        <EmptyState title="Not in a class" description={active ? (history.length > 0 ? 'This student is not enrolled in any class right now. Their earlier enrollments are kept in the history below. Use "Enroll in a class" to place them again.' : 'This student is not enrolled in any class right now.') : 'This student is not active, so they have no current class.'} />
      )}

      {canWrite && active && mode === 'none' ? (
        <div className="period-item__actions">
          {current ? <Button disabled={options.state !== 'ready'} onClick={() => setMode('transfer')}>Change class</Button> : <Button variant="primary" disabled={options.state !== 'ready'} onClick={() => setMode('enroll')}>Enroll in a class</Button>}
        </div>
      ) : null}
      {canWrite && options.state === 'loading' ? <p className="muted" role="status">Loading classes and academic years…</p> : null}
      {canWrite && options.state === 'error' ? <p className="form-error" role="alert">Classes and academic years couldn't be loaded, so enrollment is unavailable. Reload the page to try again.</p> : null}

      {mode === 'enroll' && options.state === 'ready' ? (
        <EnrollForm studentId={studentId} classes={options.classes} years={options.years} onDone={() => done('Student enrolled.')} onCancel={() => setMode('none')} />
      ) : null}
      {mode === 'transfer' && current && options.state === 'ready' ? (
        <TransferForm studentId={studentId} current={current} classes={options.classes} onDone={() => done('Class changed. The earlier class is kept in the history.')} onCancel={() => setMode('none')} />
      ) : null}

      {history.length > 0 ? (
        <div>
          <h3 className="subheading">History</h3>
          <div className="table-wrap">
            <table className="period-table">
              <thead><tr><th scope="col">Class</th><th scope="col">Year</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Outcome</th></tr></thead>
              <tbody>
                {history.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">{e.className}</th>
                    <td>{e.academicYearName}</td>
                    <td>{formatDate(e.startDate)}</td>
                    <td>{e.endDate ? formatDate(e.endDate) : '—'}</td>
                    <td><Badge variant="closed">{enrollmentLabel(e.status)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  )
}
