import { ArrowDown, ArrowUp } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Panel } from '../components/ui/Panel'
import { ClassForm } from '../features/classes/ClassForm'
import { createClass, levelLabel, listClasses, reorderClasses, updateClass } from '../features/classes/classesApi'
import type { ClassInput, SchoolClass } from '../features/classes/classesApi'
import { describeClassError } from '../features/classes/messages'

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: SchoolClass[] }
type Mode = { kind: 'none' } | { kind: 'form'; editing?: SchoolClass }

export function ClassesPage() {
  const { can } = useAuth()
  const canRead = can('school:read')
  const canManage = can('classes:manage')

  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [mode, setMode] = useState<Mode>({ kind: 'none' })
  const [showInactive, setShowInactive] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoad({ state: 'ready', items: await listClasses(signal) })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setLoad({ state: 'error' })
    }
  }, [])

  useEffect(() => {
    if (!canRead) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [canRead, refresh])

  if (!canRead) {
    return (
      <div className="page">
        <div className="page-heading"><h1>Classes</h1></div>
        <Panel title="No access">
          <EmptyState title="You can't view classes" description="Your role doesn't include this page. Ask your school's administrator if you need it." />
        </Panel>
      </div>
    )
  }

  const all = load.state === 'ready' ? load.items : []
  const visible = showInactive ? all : all.filter((c) => c.isActive)

  async function save(values: ClassInput) {
    const editing = mode.kind === 'form' ? mode.editing : undefined
    if (editing) await updateClass(editing.id, { name: values.name, level: values.level })
    else await createClass(values)
    setMode({ kind: 'none' })
    setNotice({ kind: 'success', text: editing ? 'Class updated.' : 'Class created.' })
    await refresh()
  }

  async function toggleActive(item: SchoolClass) {
    setNotice(null)
    setBusyId(item.id)
    try {
      await updateClass(item.id, { isActive: !item.isActive })
      setNotice({ kind: 'success', text: `${item.name} is now ${item.isActive ? 'inactive' : 'active'}. Its history is kept.` })
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: describeClassError(error) })
    }
    setBusyId(null)
  }

  /** Moves one class by one place in the FULL list (inactive ones included) and saves the whole order. */
  async function move(item: SchoolClass, direction: -1 | 1) {
    const ids = all.map((c) => c.id)
    const from = ids.indexOf(item.id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to]!, ids[from]!]
    setNotice(null)
    setBusyId(item.id)
    try {
      setLoad({ state: 'ready', items: await reorderClasses(ids) })
    } catch (error) {
      setNotice({ kind: 'error', text: describeClassError(error) })
      await refresh()
    }
    setBusyId(null)
  }

  return (
    <div className="page">
      <div className="page-heading">
        <h1>Classes</h1>
        <p>The classes in your school, from Nursery to JHS. Classes are never deleted, so past enrollments keep their history; mark a class inactive when it is no longer used.</p>
      </div>

      {notice ? (
        <p className={notice.kind === 'success' ? 'notice notice--success' : 'form-error'} role={notice.kind === 'success' ? 'status' : 'alert'}>{notice.text}</p>
      ) : null}

      <Panel
        title="Class list"
        badge={
          <Button variant="primary" disabled={!canManage} title={canManage ? undefined : 'You need permission to manage classes'} onClick={() => setMode({ kind: 'form' })}>
            New class
          </Button>
        }
      >
        {!canManage ? <p className="muted">You have view-only access to classes.</p> : null}

        {mode.kind === 'form' ? (
          <ClassForm key={mode.editing?.id ?? 'new-class'} initial={mode.editing} onSubmit={save} onCancel={() => setMode({ kind: 'none' })} />
        ) : null}

        {all.length > 0 ? (
          <label className="check">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive classes
          </label>
        ) : null}

        {load.state === 'loading' ? <p role="status">Loading classes…</p> : null}
        {load.state === 'error' ? (
          <div role="alert">
            <p className="form-error">The classes couldn't be loaded.</p>
            <Button onClick={() => { setLoad({ state: 'loading' }); void refresh() }}>Try again</Button>
          </div>
        ) : null}
        {load.state === 'ready' && all.length === 0 ? (
          <EmptyState
            title="No classes yet"
            description={canManage ? 'Add your classes, for example Nursery 1, KG 1, Basic 1A and JHS 1.' : 'Your school has not set up any classes yet.'}
            action={canManage ? <Button variant="primary" onClick={() => setMode({ kind: 'form' })}>New class</Button> : undefined}
          />
        ) : null}

        {visible.length > 0 ? (
          <div className="table-wrap">
            <table className="period-table">
              <thead>
                <tr><th scope="col">Order</th><th scope="col">Class</th><th scope="col">Level</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {visible.map((item) => {
                  const index = all.findIndex((c) => c.id === item.id)
                  return (
                    <tr key={item.id} className={item.isActive ? undefined : 'row--inactive'}>
                      <td>{item.sortOrder}</td>
                      <th scope="row">{item.name}</th>
                      <td>{levelLabel(item.level)}</td>
                      <td><Badge variant={item.isActive ? 'active' : 'closed'}>{item.isActive ? 'Active' : 'Inactive'}</Badge></td>
                      <td className="period-table__actions">
                        <Button aria-label={`Move ${item.name} up`} disabled={!canManage || busyId !== null || index === 0} onClick={() => void move(item, -1)}><ArrowUp size={16} aria-hidden="true" /></Button>
                        <Button aria-label={`Move ${item.name} down`} disabled={!canManage || busyId !== null || index === all.length - 1} onClick={() => void move(item, 1)}><ArrowDown size={16} aria-hidden="true" /></Button>
                        <Button disabled={!canManage || busyId !== null} onClick={() => setMode({ kind: 'form', editing: item })}>Edit</Button>
                        <Button disabled={!canManage || busyId !== null} onClick={() => void toggleActive(item)}>{item.isActive ? 'Deactivate' : 'Activate'}</Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {load.state === 'ready' && all.length > 0 && visible.length === 0 ? <p className="muted">All classes are inactive. Tick "Show inactive classes" to see them.</p> : null}
      </Panel>
    </div>
  )
}
