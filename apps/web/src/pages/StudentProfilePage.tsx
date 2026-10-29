import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Panel } from '../components/ui/Panel'
import { fieldErrors } from '../features/calendar/messages'
import { EnrollmentSection } from '../features/students/EnrollmentSection'
import { GuardianSection } from '../features/students/GuardianSection'
import { describeStudentError } from '../features/students/messages'
import { StudentForm } from '../features/students/StudentForm'
import { STATUS_VARIANT } from '../features/students/statusVariant'
import { STUDENT_STATUSES, changeStudentStatus, fullName, getStudent, statusLabel, updateStudent } from '../features/students/studentsApi'
import type { StudentProfile, StudentStatus } from '../features/students/studentsApi'
import { ApiError } from '../lib/api'
import { formatDate } from '../lib/format'

type Load = { state: 'loading' } | { state: 'missing' } | { state: 'error' } | { state: 'ready'; profile: StudentProfile }
type Notice = { kind: 'success' | 'error'; text: string }

const STATUS_HELP: Record<Exclude<StudentStatus, 'ACTIVE'>, string> = {
  WITHDRAWN: 'The student has left the school.',
  TRANSFERRED_OUT: 'The student has moved to another school.',
  GRADUATED: 'The student has completed the school.',
}

/** Changing status ends the open class enrollment in the same step. Nothing is deleted. */
function StatusSection({ studentId, status, canWrite, onChanged, onNotice }: { studentId: string; status: StudentStatus; canWrite: boolean; onChanged: () => Promise<void>; onNotice: (n: Notice) => void }) {
  const [target, setTarget] = useState<StudentStatus | ''>('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string | null>(null)

  // A student who has left can only be reactivated; an active student can leave in one of three ways.
  const choices = STUDENT_STATUSES.filter((s) => (status === 'ACTIVE' ? s.value !== 'ACTIVE' : s.value === 'ACTIVE'))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (!target) { setErrors({ status: 'Choose a status.' }); return }
    setErrors({})
    setGeneral(null)
    setBusy(true)
    try {
      const result = await changeStudentStatus(studentId, target, target !== 'ACTIVE' && effectiveDate ? effectiveDate : undefined)
      setTarget('')
      setEffectiveDate('')
      onNotice({
        kind: 'success',
        text: result.closedEnrollmentIds.length > 0 ? `Status changed to ${statusLabel(target)}. The current class enrollment was ended and kept in the history.` : `Status changed to ${statusLabel(target)}.`,
      })
      await onChanged()
    } catch (error) {
      setErrors(fieldErrors(error))
      setGeneral(describeStudentError(error))
    }
    setBusy(false)
  }

  if (!canWrite) return <p className="muted">Only staff who can manage students can change a student's status.</p>
  return (
    <form className="stack" onSubmit={submit} noValidate aria-label="Change status">
      <p className="muted">
        {status === 'ACTIVE'
          ? 'Mark a student who leaves. Their records and history are kept, and their current class enrollment is ended.'
          : 'This student is not active. Reactivating them does not put them back in a class; enroll them again afterwards.'}
      </p>
      <div className="period-form__grid">
        <div className="field">
          <label htmlFor="status-target">New status</label>
          <select id="status-target" value={target} onChange={(e) => setTarget(e.target.value as StudentStatus | '')} aria-invalid={Boolean(errors.status)}>
            <option value="">Choose a status</option>
            {choices.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {target && target !== 'ACTIVE' ? <p className="field-hint">{STATUS_HELP[target]}</p> : null}
          {errors.status ? <p className="field-error">{errors.status}</p> : null}
        </div>
        {status === 'ACTIVE' ? (
          <div className="field">
            <label htmlFor="status-date">Effective date (optional)</label>
            <input id="status-date" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} aria-invalid={Boolean(errors.effectiveDate)} />
            <p className="field-hint">Leave empty for today.</p>
            {errors.effectiveDate ? <p className="field-error">{errors.effectiveDate}</p> : null}
          </div>
        ) : null}
      </div>
      {general ? <p className="form-error" role="alert">{general}</p> : null}
      <div><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Change status'}</Button></div>
    </form>
  )
}

export function StudentProfilePage() {
  const { studentId = '' } = useParams()
  const location = useLocation()
  const { can } = useAuth()
  const canRead = can('students:read')
  const canWrite = can('students:write')

  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(() => {
    const text = (location.state as { notice?: unknown } | null)?.notice
    return typeof text === 'string' ? { kind: 'success', text } : null
  })

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoad({ state: 'ready', profile: await getStudent(studentId, signal) })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      // A malformed id, a missing student and a student of another school all look the same.
      setLoad(error instanceof ApiError && (error.status === 404 || error.status === 400) ? { state: 'missing' } : { state: 'error' })
    }
  }, [studentId])

  useEffect(() => {
    if (!canRead) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [canRead, refresh])

  const back = <p><Link to="/students">← All students</Link></p>

  if (!canRead) {
    return (
      <div className="page">
        {back}
        <Panel title="No access"><EmptyState title="You can't view students" description="Your role doesn't include this page." /></Panel>
      </div>
    )
  }
  if (load.state === 'loading') return <div className="page">{back}<p role="status">Loading student…</p></div>
  if (load.state === 'missing') {
    return <div className="page">{back}<Panel title="Student not found"><EmptyState title="We couldn't find this student" description="The link may be wrong, or the student isn't in your school." /></Panel></div>
  }
  if (load.state === 'error') {
    return (
      <div className="page">
        {back}
        <div role="alert">
          <p className="form-error">The student couldn't be loaded.</p>
          <Button onClick={() => { setLoad({ state: 'loading' }); void refresh() }}>Try again</Button>
        </div>
      </div>
    )
  }

  const { student, guardians, enrollments, current } = load.profile
  const reload = async () => { await refresh() }

  return (
    <div className="page">
      {back}
      <div className="page-heading">
        <h1>{fullName(student)}</h1>
        <p>
          Admission no. {student.admissionNumber} <Badge variant={STATUS_VARIANT[student.status]}>{statusLabel(student.status)}</Badge>
        </p>
      </div>

      {notice ? <p className={notice.kind === 'success' ? 'notice notice--success' : 'form-error'} role={notice.kind === 'success' ? 'status' : 'alert'}>{notice.text}</p> : null}

      <div className="profile-grid">
        <Panel title="Details" badge={canWrite && !editing ? <Button onClick={() => { setNotice(null); setEditing(true) }}>Edit</Button> : undefined}>
          {editing ? (
            <StudentForm
              initial={student}
              onCancel={() => setEditing(false)}
              onSubmit={async (values) => {
                await updateStudent(student.id, values)
                setEditing(false)
                setNotice({ kind: 'success', text: 'Student updated.' })
                await refresh()
              }}
            />
          ) : (
            <dl className="details">
              <div><dt>Admission number</dt><dd>{student.admissionNumber}</dd></div>
              <div><dt>First name</dt><dd>{student.firstName}</dd></div>
              <div><dt>Middle name</dt><dd>{student.middleName ?? '—'}</dd></div>
              <div><dt>Last name</dt><dd>{student.lastName}</dd></div>
              <div><dt>Date of birth</dt><dd>{student.dateOfBirth ? formatDate(student.dateOfBirth) : '—'}</dd></div>
              <div><dt>Admitted on</dt><dd>{student.admittedOn ? formatDate(student.admittedOn) : '—'}</dd></div>
            </dl>
          )}
        </Panel>

        <Panel title="Status">
          <StatusSection studentId={student.id} status={student.status} canWrite={canWrite} onChanged={reload} onNotice={setNotice} />
        </Panel>
      </div>

      <Panel title="Class and history">
        <EnrollmentSection studentId={student.id} studentStatus={student.status} enrollments={enrollments} current={current} canWrite={canWrite} onChanged={reload} onNotice={setNotice} />
      </Panel>

      <Panel title="Guardians">
        <GuardianSection studentId={student.id} guardians={guardians} canWrite={canWrite} onChanged={reload} onNotice={setNotice} />
      </Panel>
    </div>
  )
}
