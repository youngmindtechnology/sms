import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Panel } from '../components/ui/Panel'
import { formatDate } from '../lib/format'
import { AddStaffForm } from '../features/staff/AddStaffForm'
import { describeStaffError } from '../features/staff/messages'
import { changeStaffStatus, createStaff, listStaff, resetStaffPassword, ROLE_LABELS, STATUS_LABELS, updateStaffRoles } from '../features/staff/staffApi'
import type { NewStaff, StaffList, StaffMember, StaffRole } from '../features/staff/staffApi'

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; data: StaffList }
type Confirm = { kind: 'end' | 'reset'; member: StaffMember } | null
type Secret = { name: string; email: string; password: string; reason: 'created' | 'reset' } | null

const statusBadge = (status: StaffMember['status']) => (status === 'ACTIVE' ? 'active' : status === 'ENDED' ? 'closed' : 'planned')

export function StaffPage() {
  const { can } = useAuth()
  const canManage = can('staff:manage')

  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ id: string; roles: StaffRole[] } | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [secret, setSecret] = useState<Secret>(null)
  const [copied, setCopied] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoad({ state: 'ready', data: await listStaff(signal) })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setLoad({ state: 'error' })
    }
  }, [])

  useEffect(() => {
    if (!canManage) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [canManage, refresh])

  if (!canManage) {
    return (
      <div className="page">
        <div className="page-heading"><h1>Staff</h1></div>
        <Panel title="No access">
          <EmptyState title="You can't manage staff" description="Only the school's Owner and Administrators can manage staff accounts. Ask one of them if you need a change." />
        </Panel>
      </div>
    )
  }

  const data = load.state === 'ready' ? load.data : null
  const assignable = data?.assignableRoles ?? []

  /** The buttons mirror what the server allows; the server decides. */
  const manageable = (member: StaffMember) => !member.isYou && member.roles.every((role) => assignable.includes(role))

  async function run(member: StaffMember, work: () => Promise<string | void>) {
    setNotice(null)
    setBusyId(member.membershipId)
    try {
      const text = await work()
      if (text) setNotice({ kind: 'success', text })
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: describeStaffError(error) })
      await refresh()
    }
    setBusyId(null)
  }

  async function add(values: NewStaff) {
    const created = await createStaff(values)
    setAdding(false)
    setCopied(false)
    setSecret({ name: created.staff.fullName, email: created.staff.email, password: created.temporaryPassword, reason: 'created' })
    setNotice({ kind: 'success', text: `${created.staff.fullName} was added.` })
    await refresh()
  }

  async function copySecret() {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret.password)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="page">
      <div className="page-heading">
        <h1>Staff</h1>
        <p>The people who can sign in to your school. Nobody is deleted: when someone leaves, mark their membership as ended and their history stays.</p>
      </div>

      {notice ? <p className={notice.kind === 'success' ? 'notice notice--success' : 'form-error'} role={notice.kind === 'success' ? 'status' : 'alert'}>{notice.text}</p> : null}

      {secret ? (
        <div className="confirm-bar secret-bar" role="alert">
          <p className="confirm-bar__title">{secret.reason === 'created' ? 'One-time password' : 'New one-time password'} for {secret.name}</p>
          <p className="secret-bar__value" aria-label="One-time password"><code>{secret.password}</code></p>
          <p>This is shown <strong>only once</strong>. Give it to {secret.email} privately (in person, or a direct message). They sign in with it and must choose their own password straight away. If it is lost, use "Reset password".</p>
          <div className="period-form__actions">
            <Button onClick={() => void copySecret()}>{copied ? 'Copied' : 'Copy password'}</Button>
            <Button variant="primary" onClick={() => { setSecret(null); setCopied(false) }}>I have given it to them</Button>
          </div>
        </div>
      ) : null}

      <Panel
        title="People"
        badge={<Button variant="primary" disabled={load.state !== 'ready' || assignable.length === 0} onClick={() => { setAdding(true); setNotice(null) }}>Add staff</Button>}
      >
        {data && assignable.length < 5 ? <p className="muted">You can give these roles: {assignable.map((r) => ROLE_LABELS[r]).join(', ')}.</p> : null}

        {adding && data ? <AddStaffForm assignableRoles={data.assignableRoles} onSubmit={add} onCancel={() => setAdding(false)} /> : null}

        {confirm ? (
          <div className="confirm-bar" role="alertdialog" aria-label="Confirm">
            <p className="confirm-bar__title">
              {confirm.kind === 'end' ? `End ${confirm.member.fullName}'s membership?` : `Reset ${confirm.member.fullName}'s password?`}
            </p>
            <p>
              {confirm.kind === 'end'
                ? 'They lose access to this school straight away. Their history is kept and you can reactivate them later.'
                : 'Their current password stops working, they are signed out everywhere, and you get a new one-time password to give them.'}
            </p>
            <div className="period-form__actions">
              <Button
                variant="primary"
                onClick={() => {
                  const target = confirm
                  setConfirm(null)
                  void run(target.member, async () => {
                    if (target.kind === 'end') {
                      await changeStaffStatus(target.member.membershipId, 'ENDED')
                      return `${target.member.fullName}'s membership has ended.`
                    }
                    const reset = await resetStaffPassword(target.member.membershipId)
                    setCopied(false)
                    setSecret({ name: reset.staff.fullName, email: reset.staff.email, password: reset.temporaryPassword, reason: 'reset' })
                    return 'Password reset.'
                  })
                }}
              >
                {confirm.kind === 'end' ? 'End membership' : 'Reset password'}
              </Button>
              <Button onClick={() => setConfirm(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}

        {load.state === 'loading' ? <p role="status">Loading staff…</p> : null}
        {load.state === 'error' ? (
          <div role="alert">
            <p className="form-error">The staff list couldn't be loaded.</p>
            <Button onClick={() => { setLoad({ state: 'loading' }); void refresh() }}>Try again</Button>
          </div>
        ) : null}
        {data && data.staff.length === 0 ? <EmptyState title="No staff yet" description="Add the first person to give them access to this school." /> : null}

        {data && data.staff.length > 0 ? (
          <div className="table-wrap">
            <table className="period-table">
              <thead>
                <tr><th scope="col">Name</th><th scope="col">Roles</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {data.staff.map((member) => {
                  const busy = busyId !== null
                  const allowed = manageable(member)
                  const draft = editing && editing.id === member.membershipId ? editing : null
                  return (
                    <tr key={member.membershipId} className={member.status === 'ENDED' ? 'row--inactive' : undefined}>
                      <th scope="row">
                        {member.fullName}{member.isYou ? ' (you)' : ''}
                        <span className="staff-sub">{member.email}</span>
                        {member.awaitingFirstSignIn ? <span className="staff-sub">Has not chosen a password yet</span> : null}
                      </th>
                      <td>
                        {draft ? (
                          <fieldset className="role-fieldset role-fieldset--inline">
                            <legend className="sr-only">Roles for {member.fullName}</legend>
                            {assignable.map((role) => (
                              <label key={role} className="check">
                                <input
                                  type="checkbox"
                                  checked={draft.roles.includes(role)}
                                  onChange={() => setEditing({ id: draft.id, roles: draft.roles.includes(role) ? draft.roles.filter((r) => r !== role) : [...draft.roles, role] })}
                                />{' '}
                                {ROLE_LABELS[role]}
                              </label>
                            ))}
                            <span className="period-table__actions">
                              <Button
                                variant="primary"
                                disabled={busy || draft.roles.length === 0}
                                onClick={() => {
                                  const roles = draft.roles
                                  setEditing(null)
                                  void run(member, async () => {
                                    await updateStaffRoles(member.membershipId, roles)
                                    return `${member.fullName}'s roles were updated.`
                                  })
                                }}
                              >
                                Save roles
                              </Button>
                              <Button onClick={() => setEditing(null)}>Cancel</Button>
                            </span>
                          </fieldset>
                        ) : (
                          member.roles.map((r) => ROLE_LABELS[r]).join(', ')
                        )}
                      </td>
                      <td>
                        <Badge variant={statusBadge(member.status)}>{STATUS_LABELS[member.status]}</Badge>
                        {member.endedAt ? <span className="staff-sub">since {formatDate(member.endedAt.slice(0, 10))}</span> : null}
                      </td>
                      <td className="period-table__actions">
                        {member.isYou ? <span className="muted">Your own access can't be changed here.</span> : null}
                        {!member.isYou && !allowed ? <span className="muted">Only an Owner can change this person.</span> : null}
                        {allowed && member.status !== 'ENDED' ? (
                          <Button disabled={busy} onClick={() => setEditing({ id: member.membershipId, roles: member.roles })}>Edit roles</Button>
                        ) : null}
                        {allowed && member.status === 'ACTIVE' ? (
                          <Button disabled={busy} onClick={() => void run(member, async () => { await changeStaffStatus(member.membershipId, 'SUSPENDED'); return `${member.fullName} is suspended.` })}>Suspend</Button>
                        ) : null}
                        {allowed && (member.status === 'SUSPENDED' || member.status === 'ENDED') ? (
                          <Button disabled={busy} onClick={() => void run(member, async () => { await changeStaffStatus(member.membershipId, 'ACTIVE'); return `${member.fullName} is active again.` })}>Reactivate</Button>
                        ) : null}
                        {allowed && member.status !== 'ENDED' ? <Button disabled={busy} onClick={() => setConfirm({ kind: 'end', member })}>End</Button> : null}
                        {allowed && member.status === 'ACTIVE' ? <Button disabled={busy} onClick={() => setConfirm({ kind: 'reset', member })}>Reset password</Button> : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
    </div>
  )
}
