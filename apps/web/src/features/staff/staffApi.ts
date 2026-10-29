import { api } from '../../lib/api'

export type StaffRole = 'OWNER' | 'HEADTEACHER' | 'ADMINISTRATOR' | 'TEACHER' | 'BURSAR'
export type StaffStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'ENDED'

export const ROLE_LABELS: Record<StaffRole, string> = {
  OWNER: 'Owner',
  HEADTEACHER: 'Headteacher',
  ADMINISTRATOR: 'Administrator',
  TEACHER: 'Teacher',
  BURSAR: 'Bursar',
}
export const STATUS_LABELS: Record<StaffStatus, string> = {
  INVITED: 'Invited',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  ENDED: 'Ended',
}

/** What the server sends: no user id, no password data. */
export interface StaffMember {
  membershipId: string
  email: string
  fullName: string
  status: StaffStatus
  roles: StaffRole[]
  endedAt: string | null
  createdAt: string
  /** Still on the temporary password: has not chosen their own yet. */
  awaitingFirstSignIn: boolean
  isYou: boolean
}

export interface StaffList { staff: StaffMember[]; assignableRoles: StaffRole[] }
export interface StaffWithPassword { staff: StaffMember; temporaryPassword: string }
export interface NewStaff { email: string; fullName: string; roles: StaffRole[] }

const base = '/api/staff'

export const listStaff = (signal?: AbortSignal) => api<StaffList>(base, { signal })
export const createStaff = (input: NewStaff) => api<StaffWithPassword>(base, { method: 'POST', body: input })
export const updateStaffRoles = (id: string, roles: StaffRole[]) => api<StaffMember>(`${base}/${id}/roles`, { method: 'PATCH', body: { roles } })
export const changeStaffStatus = (id: string, status: 'ACTIVE' | 'SUSPENDED' | 'ENDED') => api<StaffMember>(`${base}/${id}/status`, { method: 'POST', body: { status } })
export const resetStaffPassword = (id: string) => api<StaffWithPassword>(`${base}/${id}/reset-password`, { method: 'POST' })
