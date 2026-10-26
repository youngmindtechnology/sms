import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Panel } from '../components/ui/Panel'
import {
  activateTerm, activateYear, closeTerm, closeYear, createTerm, createYear, listTerms, listYears, updateTerm, updateYear,
} from '../features/calendar/calendarApi'
import type { AcademicYear, PeriodStatus, Term } from '../features/calendar/calendarApi'
import { describeError } from '../features/calendar/messages'
import { PeriodForm } from '../features/calendar/PeriodForm'
import type { PeriodValues } from '../features/calendar/PeriodForm'
import { formatDate } from '../lib/format'

type Load<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: T[] }
type Mode =
  | { kind: 'none' }
  | { kind: 'year'; editing?: AcademicYear }
  | { kind: 'term'; editing?: Term }
interface Confirmation { title: string; message: string; confirmLabel: string; run: () => Promise<unknown> }

const STATUS_LABEL: Record<PeriodStatus, string> = { PLANNED: 'Planned', ACTIVE: 'Current', CLOSED: 'Closed' }
const STATUS_VARIANT: Record<PeriodStatus, 'planned' | 'active' | 'closed'> = { PLANNED: 'planned', ACTIVE: 'active', CLOSED: 'closed' }

function StatusBadge({ status }: { status: PeriodStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
}

export function CalendarPage() {
  const { can } = useAuth()
  const canRead = can('academics:read')
  const canManage = can('calendar:manage')

  const [years, setYears] = useState<Load<AcademicYear>>({ state: 'loading' })
  const [terms, setTerms] = useState<Load<Term>>({ state: 'loading' })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'none' })
  const [confirm, setConfirm] = useState<Confirmation | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const loadYears = useCallback(async (signal?: AbortSignal) => {
    try {
      const items = await listYears(signal)
      setYears({ state: 'ready', items })
      setSelectedId((current) => {
        if (current && items.some((y) => y.id === current)) return current
        return (items.find((y) => y.status === 'ACTIVE') ?? items[0])?.id ?? null
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setYears({ state: 'error' })
    }
  }, [])

  const loadTerms = useCallback(async (yearId: string, signal?: AbortSignal) => {
    try {
      setTerms({ state: 'ready', items: await listTerms(yearId, signal) })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setTerms({ state: 'error' })
    }
  }, [])

  useEffect(() => {
    if (!canRead) return
    const controller = new AbortController()
    void loadYears(controller.signal)
    return () => controller.abort()
  }, [canRead, loadYears])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    void loadTerms(selectedId, controller.signal)
    return () => controller.abort()
  }, [selectedId, loadTerms])

  if (!canRead) {
    return (
      <div className="page">
        <div className="page-heading"><h1>Academic Calendar</h1></div>
        <Panel title="No access">
          <EmptyState title="You can't view the academic calendar" description="Your role doesn't include this page. Ask your school's administrator if you need it." />
        </Panel>
      </div>
    )
  }

  const yearList = years.state === 'ready' ? years.items : []
  const selected = yearList.find((y) => y.id === selectedId) ?? null
  const activeYear = yearList.find((y) => y.status === 'ACTIVE') ?? null
  const termList = terms.state === 'ready' ? terms.items : []

  async function refresh() {
    await loadYears()
    if (selectedId) await loadTerms(selectedId)
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setNotice(null)
    try {
      await action()
      setNotice({ kind: 'success', text: success })
      await refresh()
      return true
    } catch (error) {
      setNotice({ kind: 'error', text: describeError(error) })
      return false
    }
  }

  async function saveYear(values: PeriodValues) {
    const editing = mode.kind === 'year' ? mode.editing : undefined
    const saved = editing
      ? await updateYear(editing.id, { name: values.name, startDate: values.startDate, endDate: values.endDate })
      : await createYear({ name: values.name, startDate: values.startDate, endDate: values.endDate })
    setMode({ kind: 'none' })
    setNotice({ kind: 'success', text: editing ? 'Academic year updated.' : 'Academic year created.' })
    setSelectedId(saved.id)
    await loadYears()
    await loadTerms(saved.id)
  }

  async function saveTerm(values: PeriodValues) {
    if (!selected) return
    const editing = mode.kind === 'term' ? mode.editing : undefined
    if (editing) await updateTerm(selected.id, editing.id, values)
    else await createTerm(selected.id, values)
    setMode({ kind: 'none' })
    setNotice({ kind: 'success', text: editing ? 'Term updated.' : 'Term created.' })
    await loadTerms(selected.id)
  }

  function ask(c: Confirmation) { setNotice(null); setConfirm(c) }
  async function confirmed() {
    if (!confirm) return
    setConfirmBusy(true)
    const action = confirm
    await run(action.run, `${action.title} — done.`)
    setConfirmBusy(false)
    setConfirm(null)
  }

  const viewOnlyHint = canManage ? null : <p className="muted">You have view-only access to the calendar.</p>

  return (
    <div className="page">
      <div className="page-heading">
        <h1>Academic Calendar</h1>
        <p>Your school's academic years and the terms inside them. The current year and term are what the rest of the system uses.</p>
      </div>

      {notice ? (
        <p className={notice.kind === 'success' ? 'notice notice--success' : 'form-error'} role={notice.kind === 'success' ? 'status' : 'alert'}>
          {notice.text}
        </p>
      ) : null}

      {confirm ? (
        <div className="confirm-bar" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-message">
          <p id="confirm-title" className="confirm-bar__title">{confirm.title}</p>
          <p id="confirm-message">{confirm.message}</p>
          <div className="period-form__actions">
            <Button variant="primary" onClick={() => void confirmed()} disabled={confirmBusy}>{confirmBusy ? 'Working…' : confirm.confirmLabel}</Button>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={confirmBusy}>Cancel</Button>
          </div>
        </div>
      ) : null}

      <Panel
        title="Academic years"
        badge={
          <Button variant="primary" disabled={!canManage} title={canManage ? undefined : 'You need permission to manage the calendar'} onClick={() => setMode({ kind: 'year' })}>
            New academic year
          </Button>
        }
      >
        {viewOnlyHint}
        {mode.kind === 'year' ? (
          <PeriodForm
            key={mode.editing?.id ?? 'new-year'}
            title={mode.editing ? 'Edit academic year' : 'New academic year'}
            initial={mode.editing}
            submitLabel={mode.editing ? 'Save changes' : 'Create year'}
            onSubmit={saveYear}
            onCancel={() => setMode({ kind: 'none' })}
          />
        ) : null}

        {years.state === 'loading' ? <p role="status">Loading academic years…</p> : null}
        {years.state === 'error' ? (
          <div role="alert">
            <p className="form-error">The academic years couldn't be loaded.</p>
            <Button onClick={() => { setYears({ state: 'loading' }); void loadYears() }}>Try again</Button>
          </div>
        ) : null}
        {years.state === 'ready' && yearList.length === 0 ? (
          <EmptyState
            title="No academic years yet"
            description={canManage ? 'Create your first academic year to start organising terms.' : 'Your school has not set up an academic year yet.'}
            action={canManage ? <Button variant="primary" onClick={() => setMode({ kind: 'year' })}>New academic year</Button> : undefined}
          />
        ) : null}

        {yearList.length > 0 ? (
          <ul className="period-list">
            {yearList.map((year) => (
              <li key={year.id} className={`period-item${year.id === selectedId ? ' period-item--selected' : ''}`}>
                <button type="button" className="period-item__main" onClick={() => { setSelectedId(year.id); setMode({ kind: 'none' }) }} aria-pressed={year.id === selectedId}>
                  <span className="period-item__name">{year.name}</span>
                  <span className="period-item__dates">{formatDate(year.startDate)} – {formatDate(year.endDate)}</span>
                </button>
                <StatusBadge status={year.status} />
                <span className="period-item__actions">
                  <Button disabled={!canManage || year.status === 'CLOSED'} onClick={() => setMode({ kind: 'year', editing: year })}>Edit</Button>
                  {year.status === 'PLANNED' ? (
                    <Button
                      disabled={!canManage}
                      onClick={() => ask({
                        title: `Make ${year.name} the current year`,
                        message: activeYear
                          ? `${activeYear.name} and its current term will be closed. Closed periods can't be reopened.`
                          : 'This becomes the current academic year.',
                        confirmLabel: 'Make current',
                        run: () => activateYear(year.id),
                      })}
                    >
                      Make current
                    </Button>
                  ) : null}
                  {year.status === 'ACTIVE' ? (
                    <Button
                      disabled={!canManage}
                      onClick={() => ask({
                        title: `Close ${year.name}`,
                        message: 'The year and its current term will be closed. Closed periods can no longer be edited or reopened.',
                        confirmLabel: 'Close year',
                        run: () => closeYear(year.id),
                      })}
                    >
                      Close year
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {selected ? (
        <Panel
          title={`Terms in ${selected.name}`}
          badge={
            <Button
              variant="primary"
              disabled={!canManage || selected.status === 'CLOSED'}
              title={!canManage ? 'You need permission to manage the calendar' : selected.status === 'CLOSED' ? 'This year is closed' : undefined}
              onClick={() => setMode({ kind: 'term' })}
            >
              New term
            </Button>
          }
        >
          {mode.kind === 'term' ? (
            <PeriodForm
              key={mode.editing?.id ?? 'new-term'}
              title={mode.editing ? 'Edit term' : 'New term'}
              withSequence
              initial={mode.editing}
              submitLabel={mode.editing ? 'Save changes' : 'Create term'}
              onSubmit={saveTerm}
              onCancel={() => setMode({ kind: 'none' })}
            />
          ) : null}

          {terms.state === 'loading' ? <p role="status">Loading terms…</p> : null}
          {terms.state === 'error' ? (
            <div role="alert">
              <p className="form-error">The terms couldn't be loaded.</p>
              <Button onClick={() => { setTerms({ state: 'loading' }); void loadTerms(selected.id) }}>Try again</Button>
            </div>
          ) : null}
          {terms.state === 'ready' && termList.length === 0 ? (
            <EmptyState
              title="No terms in this year yet"
              description={canManage && selected.status !== 'CLOSED' ? 'Add the terms for this academic year, for example Term 1, Term 2 and Term 3.' : 'No terms have been added to this year.'}
              action={canManage && selected.status !== 'CLOSED' ? <Button variant="primary" onClick={() => setMode({ kind: 'term' })}>New term</Button> : undefined}
            />
          ) : null}

          {termList.length > 0 ? (
            <div className="table-wrap">
              <table className="period-table">
                <thead>
                  <tr><th scope="col">No.</th><th scope="col">Term</th><th scope="col">Dates</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {termList.map((term) => (
                    <tr key={term.id}>
                      <td>{term.sequence}</td>
                      <th scope="row">{term.name}</th>
                      <td>{formatDate(term.startDate)} – {formatDate(term.endDate)}</td>
                      <td><StatusBadge status={term.status} /></td>
                      <td className="period-table__actions">
                        <Button disabled={!canManage || term.status === 'CLOSED'} onClick={() => setMode({ kind: 'term', editing: term })}>Edit</Button>
                        {term.status === 'PLANNED' ? (
                          <Button
                            disabled={!canManage || selected.status !== 'ACTIVE'}
                            title={selected.status !== 'ACTIVE' ? 'Make the academic year current first' : undefined}
                            onClick={() => ask({
                              title: `Make ${term.name} the current term`,
                              message: 'Any other current term will be closed. Closed periods can\'t be reopened.',
                              confirmLabel: 'Make current',
                              run: () => activateTerm(selected.id, term.id),
                            })}
                          >
                            Make current
                          </Button>
                        ) : null}
                        {term.status === 'ACTIVE' ? (
                          <Button
                            disabled={!canManage}
                            onClick={() => ask({
                              title: `Close ${term.name}`,
                              message: 'Closed terms can no longer be edited or reopened.',
                              confirmLabel: 'Close term',
                              run: () => closeTerm(selected.id, term.id),
                            })}
                          >
                            Close term
                          </Button>
                        ) : null}
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
