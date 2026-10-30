import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Panel } from '../components/ui/Panel'
import { listYears } from '../features/calendar/calendarApi'
import type { AcademicYear } from '../features/calendar/calendarApi'
import { listClasses } from '../features/classes/classesApi'
import type { SchoolClass } from '../features/classes/classesApi'
import { SubjectForm } from '../features/subjects/SubjectForm'
import { TeacherForm } from '../features/subjects/TeacherForm'
import { describeSubjectError } from '../features/subjects/messages'
import {
  assignTeacher, createSubject, endAssignment, listEligibleTeachers, listSubjects, replaceTeacher, updateSubject,
} from '../features/subjects/subjectsApi'
import type { Assignment, ClassSubjects, EligibleTeacher, SubjectInput, SubjectWithTeachers } from '../features/subjects/subjectsApi'

type Setup = { state: 'loading' } | { state: 'error' } | { state: 'ready'; classes: SchoolClass[]; years: AcademicYear[] }
type Subjects = { state: 'idle' } | { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: ClassSubjects }
type Teachers = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: EligibleTeacher[] }
type Mode =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; subject: SubjectWithTeachers }
  | { kind: 'assign'; subject: SubjectWithTeachers }
  | { kind: 'replace'; subject: SubjectWithTeachers; assignment: Assignment }
type Confirm = { kind: 'deactivate'; subject: SubjectWithTeachers } | { kind: 'end'; subject: SubjectWithTeachers; assignment: Assignment } | null

/** The year to open with: the current one, else the first planned one, else the newest. */
function defaultYear(years: AcademicYear[]): string {
  return (years.find((y) => y.status === 'ACTIVE') ?? years.find((y) => y.status === 'PLANNED') ?? years[0])?.id ?? ''
}

export function SubjectsPage() {
  const { can } = useAuth()
  const canRead = can('academics:read')
  const canManage = can('subjects:manage')
  const canAssign = can('subjects:assign')

  const [setup, setSetup] = useState<Setup>({ state: 'loading' })
  const [classId, setClassId] = useState('')
  const [yearId, setYearId] = useState('')
  const [subjects, setSubjects] = useState<Subjects>({ state: 'idle' })
  const [teachers, setTeachers] = useState<Teachers>({ state: 'loading' })
  const [mode, setMode] = useState<Mode>({ kind: 'none' })
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const loadSetup = useCallback(async (signal?: AbortSignal) => {
    try {
      const [classes, years] = await Promise.all([listClasses(signal), listYears(signal)])
      setSetup({ state: 'ready', classes, years })
      setClassId((current) => current || (classes.find((c) => c.isActive) ?? classes[0])?.id || '')
      setYearId((current) => current || defaultYear(years))
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setSetup({ state: 'error' })
    }
  }, [])

  const loadSubjects = useCallback(async (cls: string, year: string, signal?: AbortSignal) => {
    try {
      setSubjects({ state: 'ready', data: await listSubjects(cls, year || null, signal) })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setSubjects({ state: 'error' })
    }
  }, [])

  const loadTeachers = useCallback(async (signal?: AbortSignal) => {
    try {
      setTeachers({ state: 'ready', items: await listEligibleTeachers(signal) })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setTeachers({ state: 'error' })
    }
  }, [])

  useEffect(() => {
    if (!canRead) return
    const controller = new AbortController()
    void loadSetup(controller.signal)
    return () => controller.abort()
  }, [canRead, loadSetup])

  useEffect(() => {
    if (!canAssign) return
    const controller = new AbortController()
    void loadTeachers(controller.signal)
    return () => controller.abort()
  }, [canAssign, loadTeachers])

  useEffect(() => {
    if (!classId) return
    const controller = new AbortController()
    void loadSubjects(classId, yearId, controller.signal)
    return () => controller.abort()
  }, [classId, yearId, loadSubjects])

  if (!canRead) {
    return (
      <div className="page">
        <div className="page-heading"><h1>Subjects</h1></div>
        <Panel title="No access">
          <EmptyState title="You can't view subjects" description="Your role doesn't include this page. Ask your school's administrator if you need it." />
        </Panel>
      </div>
    )
  }

  const classes = setup.state === 'ready' ? setup.classes : []
  const years = setup.state === 'ready' ? setup.years : []
  const selectedClass = classes.find((c) => c.id === classId)
  const selectedYear = years.find((y) => y.id === yearId)
  const yearClosed = selectedYear?.status === 'CLOSED'
  const data = subjects.state === 'ready' ? subjects.data : null

  function pick(next: { classId?: string; yearId?: string }) {
    setMode({ kind: 'none' })
    setConfirm(null)
    setNotice(null)
    if (next.classId !== undefined) setClassId(next.classId)
    if (next.yearId !== undefined) setYearId(next.yearId)
  }

  async function reload() {
    await loadSubjects(classId, yearId)
  }

  async function run(work: () => Promise<string>) {
    setNotice(null)
    setBusy(true)
    try {
      const text = await work()
      setNotice({ kind: 'success', text })
      await reload()
    } catch (error) {
      setNotice({ kind: 'error', text: describeSubjectError(error) })
      await reload()
    }
    setBusy(false)
  }

  async function saveSubject(values: SubjectInput) {
    const editing = mode.kind === 'edit' ? mode.subject : undefined
    if (editing) await updateSubject(editing.id, { name: values.name, code: values.code === '' ? null : values.code })
    else await createSubject(classId, values)
    setMode({ kind: 'none' })
    setNotice({ kind: 'success', text: editing ? 'Subject updated.' : 'Subject created.' })
    await reload()
  }

  async function saveTeacher(teacherMembershipId: string) {
    if (mode.kind === 'assign') await assignTeacher(mode.subject.id, yearId, teacherMembershipId)
    else if (mode.kind === 'replace') await replaceTeacher(mode.assignment.id, teacherMembershipId)
    else return
    const replaced = mode.kind === 'replace'
    setMode({ kind: 'none' })
    setNotice({ kind: 'success', text: replaced ? 'Teacher replaced. The earlier assignment is kept in the history.' : 'Teacher assigned.' })
    await reload()
  }

  /** Teachers who can still be chosen for a subject: everyone eligible who is not already on it this year. */
  function choices(subject: SubjectWithTeachers): EligibleTeacher[] {
    if (teachers.state !== 'ready') return []
    const taken = new Set(subject.teachers.map((t) => t.teacherMembershipId))
    return teachers.items.filter((t) => !taken.has(t.membershipId))
  }

  const assignDisabled = !canAssign || busy || yearClosed || teachers.state !== 'ready'

  return (
    <div className="page">
      <div className="page-heading">
        <h1>Subjects</h1>
        <p>The subjects taught in each class, and the teachers assigned to them for an academic year. Subjects and assignments are never deleted: deactivate a subject or end an assignment and the history is kept. Assessments and scores come in a later phase.</p>
      </div>

      {notice ? (
        <p className={notice.kind === 'success' ? 'notice notice--success' : 'form-error'} role={notice.kind === 'success' ? 'status' : 'alert'}>{notice.text}</p>
      ) : null}

      {setup.state === 'loading' ? <p role="status">Loading classes and academic years…</p> : null}
      {setup.state === 'error' ? (
        <div role="alert">
          <p className="form-error">Classes and academic years couldn't be loaded.</p>
          <Button onClick={() => { setSetup({ state: 'loading' }); void loadSetup() }}>Try again</Button>
        </div>
      ) : null}

      {setup.state === 'ready' && classes.length === 0 ? (
        <Panel title="Subjects">
          <EmptyState title="No classes yet" description="Subjects belong to a class. Add your classes first, under Classes." />
        </Panel>
      ) : null}

      {setup.state === 'ready' && classes.length > 0 ? (
        <Panel
          title="Subjects by class"
          badge={
            <Button
              variant="primary"
              disabled={!canManage || busy || !selectedClass?.isActive}
              title={!canManage ? 'You need permission to manage subjects' : !selectedClass?.isActive ? 'This class is inactive' : undefined}
              onClick={() => { setMode({ kind: 'create' }); setConfirm(null); setNotice(null) }}
            >
              New subject
            </Button>
          }
        >
          {!canManage && !canAssign ? <p className="muted">You have view-only access to subjects.</p> : null}

          <div className="period-form__grid">
            <div className="field">
              <label htmlFor="subjects-class">Class</label>
              <select id="subjects-class" value={classId} onChange={(e) => pick({ classId: e.target.value })}>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (inactive)'}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="subjects-year">Academic year</label>
              <select id="subjects-year" value={yearId} onChange={(e) => pick({ yearId: e.target.value })}>
                {years.length === 0 ? <option value="">No academic year yet</option> : null}
                {years.map((y) => <option key={y.id} value={y.id}>{y.name}{y.status === 'ACTIVE' ? ' (current)' : y.status === 'CLOSED' ? ' (closed)' : ''}</option>)}
              </select>
            </div>
          </div>
          {years.length === 0 ? <p className="muted">There is no academic year yet. Add one under Academic Calendar to assign teachers.</p> : null}
          {yearClosed ? <p className="muted">This academic year is closed. You can view its teachers and end assignments, but not assign new ones.</p> : null}
          {canAssign && teachers.state === 'error' ? <p className="form-error" role="alert">The list of teachers couldn't be loaded, so assigning is unavailable. Reload the page to try again.</p> : null}

          {mode.kind === 'create' || mode.kind === 'edit' ? (
            <SubjectForm
              key={mode.kind === 'edit' ? mode.subject.id : 'new-subject'}
              className={selectedClass?.name ?? 'this class'}
              initial={mode.kind === 'edit' ? mode.subject : undefined}
              onSubmit={saveSubject}
              onCancel={() => setMode({ kind: 'none' })}
            />
          ) : null}

          {mode.kind === 'assign' || mode.kind === 'replace' ? (
            <TeacherForm
              key={mode.kind === 'replace' ? mode.assignment.id : `assign-${mode.subject.id}`}
              title={mode.kind === 'replace' ? `Replace ${mode.assignment.teacherName} on ${mode.subject.name}` : `Assign a teacher to ${mode.subject.name}`}
              submitLabel={mode.kind === 'replace' ? 'Replace teacher' : 'Assign teacher'}
              teachers={choices(mode.subject)}
              onSubmit={saveTeacher}
              onCancel={() => setMode({ kind: 'none' })}
            />
          ) : null}

          {confirm ? (
            <div className="confirm-bar" role="alertdialog" aria-label="Confirm">
              <p className="confirm-bar__title">
                {confirm.kind === 'deactivate' ? `Deactivate ${confirm.subject.name}?` : `End ${confirm.assignment.teacherName}'s assignment to ${confirm.subject.name}?`}
              </p>
              <p>
                {confirm.kind === 'deactivate'
                  ? 'No new teachers can be assigned to it. Its history is kept and you can reactivate it later.'
                  : 'They are no longer shown as teaching this subject. The assignment is kept in the history.'}
              </p>
              <div className="period-form__actions">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    const target = confirm
                    setConfirm(null)
                    void run(async () => {
                      if (target.kind === 'deactivate') {
                        await updateSubject(target.subject.id, { isActive: false })
                        return `${target.subject.name} is now inactive. Its history is kept.`
                      }
                      await endAssignment(target.assignment.id)
                      return `${target.assignment.teacherName}'s assignment has ended.`
                    })
                  }}
                >
                  {confirm.kind === 'deactivate' ? 'Deactivate' : 'End assignment'}
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(null)}>Keep it</Button>
              </div>
            </div>
          ) : null}

          {subjects.state === 'loading' ? <p role="status">Loading subjects…</p> : null}
          {subjects.state === 'error' ? (
            <div role="alert">
              <p className="form-error">The subjects couldn't be loaded.</p>
              <Button onClick={() => { setSubjects({ state: 'loading' }); void reload() }}>Try again</Button>
            </div>
          ) : null}

          {data && data.subjects.length === 0 ? (
            <EmptyState
              title={`No subjects in ${data.class.name} yet`}
              description={canManage ? 'Add the subjects this class studies, for example Mathematics and English Language.' : 'No subjects have been set up for this class yet.'}
              action={canManage && data.class.isActive ? <Button variant="primary" onClick={() => setMode({ kind: 'create' })}>New subject</Button> : undefined}
            />
          ) : null}

          {data && data.subjects.length > 0 ? (
            <div className="table-wrap">
              <table className="period-table">
                <thead>
                  <tr>
                    <th scope="col">Subject</th><th scope="col">Code</th><th scope="col">Status</th>
                    <th scope="col">Teachers{selectedYear ? ` (${selectedYear.name})` : ''}</th><th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.subjects.map((subject) => (
                    <tr key={subject.id} className={subject.isActive ? undefined : 'row--inactive'}>
                      <th scope="row">{subject.name}</th>
                      <td>{subject.code ?? '—'}</td>
                      <td><Badge variant={subject.isActive ? 'active' : 'closed'}>{subject.isActive ? 'Active' : 'Inactive'}</Badge></td>
                      <td>
                        {!yearId ? <span className="muted">Choose a year</span> : subject.teachers.length === 0 ? <span className="muted">No teacher assigned</span> : (
                          <ul className="plain-list">
                            {subject.teachers.map((t) => (
                              <li key={t.id}>
                                {t.teacherName}{' '}
                                {canAssign ? (
                                  <>
                                    <Button aria-label={`Replace ${t.teacherName} on ${subject.name}`} disabled={assignDisabled || !subject.isActive} onClick={() => { setMode({ kind: 'replace', subject, assignment: t }); setConfirm(null) }}>Replace</Button>{' '}
                                    <Button aria-label={`End ${t.teacherName}'s assignment to ${subject.name}`} disabled={!canAssign || busy} onClick={() => { setConfirm({ kind: 'end', subject, assignment: t }); setMode({ kind: 'none' }) }}>End</Button>
                                  </>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="period-table__actions">
                        <Button aria-label={`Assign a teacher to ${subject.name}`} disabled={assignDisabled || !subject.isActive || !yearId} title={!canAssign ? 'You need permission to assign teachers' : undefined} onClick={() => { setMode({ kind: 'assign', subject }); setConfirm(null) }}>Assign teacher</Button>
                        <Button aria-label={`Edit ${subject.name}`} disabled={!canManage || busy} onClick={() => { setMode({ kind: 'edit', subject }); setConfirm(null) }}>Edit</Button>
                        {subject.isActive ? (
                          <Button aria-label={`Deactivate ${subject.name}`} disabled={!canManage || busy} onClick={() => { setConfirm({ kind: 'deactivate', subject }); setMode({ kind: 'none' }) }}>Deactivate</Button>
                        ) : (
                          <Button aria-label={`Activate ${subject.name}`} disabled={!canManage || busy} onClick={() => void run(async () => { await updateSubject(subject.id, { isActive: true }); return `${subject.name} is active again.` })}>Activate</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  )
}
