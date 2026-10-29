import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Panel } from '../components/ui/Panel'
import { StudentForm } from '../features/students/StudentForm'
import { STATUS_VARIANT } from '../features/students/statusVariant'
import { STUDENT_STATUSES, fullName, listStudents, registerStudent, statusLabel } from '../features/students/studentsApi'
import type { StudentPage, StudentStatus } from '../features/students/studentsApi'

const PAGE_SIZE = 20
type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: StudentPage }

export function StudentsPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const canRead = can('students:read')
  const canWrite = can('students:write')

  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StudentStatus | ''>('')
  const [page, setPage] = useState(1)
  const [registering, setRegistering] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoad({ state: 'ready', data: await listStudents({ search, status, page, pageSize: PAGE_SIZE }, signal) })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setLoad({ state: 'error' })
    }
  }, [search, status, page])

  useEffect(() => {
    if (!canRead) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [canRead, refresh])

  if (!canRead) {
    return (
      <div className="page">
        <div className="page-heading"><h1>Students</h1></div>
        <Panel title="No access">
          <EmptyState title="You can't view students" description="Your role doesn't include this page. Ask your school's administrator if you need it." />
        </Panel>
      </div>
    )
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    setLoad({ state: 'loading' })
    setPage(1)
    setSearch(searchText.trim())
  }

  const data = load.state === 'ready' ? load.data : null
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const filtered = search !== '' || status !== ''

  return (
    <div className="page">
      <div className="page-heading">
        <h1>Students</h1>
        <p>Register students, keep their guardians and class history, and find anyone by name or admission number. Students are never deleted: someone who leaves is marked withdrawn, transferred or graduated.</p>
      </div>


      <Panel
        title="Student list"
        badge={
          <Button variant="primary" disabled={!canWrite} title={canWrite ? undefined : 'You need permission to register students'} onClick={() => setRegistering(true)}>
            Register student
          </Button>
        }
      >
        {!canWrite ? <p className="muted">You have view-only access to students.</p> : null}

        {registering ? (
          <StudentForm
            onCancel={() => setRegistering(false)}
            onSubmit={async (values) => {
              const created = await registerStudent(values)
              setRegistering(false)
              navigate(`/students/${created.id}`, { state: { notice: 'Student registered. You can now add a guardian and enroll them in a class.' } })
            }}
          />
        ) : null}

        <form className="toolbar" onSubmit={submitSearch} role="search" aria-label="Search students">
          <div className="field toolbar__search">
            <label htmlFor="student-search">Search by name or admission number</label>
            <input id="student-search" type="search" value={searchText} maxLength={100} onChange={(e) => setSearchText(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="student-status">Status</label>
            <select id="student-status" value={status} onChange={(e) => { setLoad({ state: 'loading' }); setPage(1); setStatus(e.target.value as StudentStatus | '') }}>
              <option value="">All statuses</option>
              {STUDENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <Button type="submit" variant="primary">Search</Button>
          {filtered ? <Button onClick={() => { setSearchText(''); setLoad({ state: 'loading' }); setPage(1); setSearch(''); setStatus('') }}>Clear</Button> : null}
        </form>

        {load.state === 'loading' ? <p role="status">Loading students…</p> : null}
        {load.state === 'error' ? (
          <div role="alert">
            <p className="form-error">The students couldn't be loaded.</p>
            <Button onClick={() => { setLoad({ state: 'loading' }); void refresh() }}>Try again</Button>
          </div>
        ) : null}

        {data && data.items.length === 0 ? (
          <EmptyState
            title={filtered ? 'No students match' : 'No students yet'}
            description={filtered ? 'Try a different name or admission number, or clear the filters.' : canWrite ? 'Register your first student to get started.' : 'Your school has not registered any students yet.'}
            action={!filtered && canWrite ? <Button variant="primary" onClick={() => setRegistering(true)}>Register student</Button> : undefined}
          />
        ) : null}

        {data && data.items.length > 0 ? (
          <>
            <div className="table-wrap">
              <table className="period-table">
                <thead>
                  <tr><th scope="col">Admission no.</th><th scope="col">Name</th><th scope="col">Class</th><th scope="col">Status</th></tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.id} className={s.status === 'ACTIVE' ? undefined : 'row--inactive'}>
                      <td>{s.admissionNumber}</td>
                      <th scope="row"><Link to={`/students/${s.id}`}>{fullName(s)}</Link></th>
                      <td>{s.current ? `${s.current.className} · ${s.current.academicYearName}` : '—'}</td>
                      <td><Badge variant={STATUS_VARIANT[s.status]}>{statusLabel(s.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="pager" aria-label="Pages">
              <span className="muted">{data.total} {data.total === 1 ? 'student' : 'students'} · page {data.page} of {pages}</span>
              <div className="period-item__actions">
                <Button disabled={page <= 1} onClick={() => { setLoad({ state: 'loading' }); setPage(page - 1) }}>Previous</Button>
                <Button disabled={page >= pages} onClick={() => { setLoad({ state: 'loading' }); setPage(page + 1) }}>Next</Button>
              </div>
            </nav>
          </>
        ) : null}
      </Panel>
    </div>
  )
}
