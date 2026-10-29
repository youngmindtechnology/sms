import { api } from '../../lib/api'

export type StudentStatus = 'ACTIVE' | 'WITHDRAWN' | 'TRANSFERRED_OUT' | 'GRADUATED'

export const STUDENT_STATUSES: { value: StudentStatus; label: string }[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
  { value: 'TRANSFERRED_OUT', label: 'Transferred out' },
  { value: 'GRADUATED', label: 'Graduated' },
]
export const statusLabel = (status: StudentStatus) => STUDENT_STATUSES.find((s) => s.value === status)?.label ?? status

export type GuardianRelationship =
  | 'MOTHER' | 'FATHER' | 'GRANDPARENT' | 'SIBLING' | 'UNCLE_OR_AUNT' | 'OTHER_RELATIVE' | 'LEGAL_GUARDIAN' | 'OTHER'

export const RELATIONSHIPS: { value: GuardianRelationship; label: string }[] = [
  { value: 'MOTHER', label: 'Mother' },
  { value: 'FATHER', label: 'Father' },
  { value: 'GRANDPARENT', label: 'Grandparent' },
  { value: 'SIBLING', label: 'Brother or sister' },
  { value: 'UNCLE_OR_AUNT', label: 'Uncle or aunt' },
  { value: 'OTHER_RELATIVE', label: 'Other relative' },
  { value: 'LEGAL_GUARDIAN', label: 'Legal guardian' },
  { value: 'OTHER', label: 'Other' },
]
export const relationshipLabel = (value: GuardianRelationship) => RELATIONSHIPS.find((r) => r.value === value)?.label ?? value

export type EnrollmentStatus = 'ENROLLED' | 'PROMOTED' | 'REPEATED' | 'CLASS_CHANGED' | 'WITHDRAWN' | 'COMPLETED'
const ENROLLMENT_LABELS: Record<EnrollmentStatus, string> = {
  ENROLLED: 'Enrolled', PROMOTED: 'Promoted', REPEATED: 'Repeated', CLASS_CHANGED: 'Changed class', WITHDRAWN: 'Withdrawn', COMPLETED: 'Completed',
}
export const enrollmentLabel = (status: EnrollmentStatus) => ENROLLMENT_LABELS[status] ?? status

export interface StudentSummary {
  id: string
  admissionNumber: string
  firstName: string
  middleName: string | null
  lastName: string
  status: StudentStatus
}
export interface CurrentPlacement { enrollmentId: string; classId: string; className: string; academicYearId: string; academicYearName: string }
export interface StudentListItem extends StudentSummary { current: CurrentPlacement | null }
export interface Student extends StudentSummary { dateOfBirth: string | null; admittedOn: string | null }

export interface Guardian { id: string; fullName: string; phone: string | null; email: string | null }
export interface GuardianLink extends Guardian { relationship: GuardianRelationship; isPrimaryContact: boolean }
export interface Enrollment {
  id: string
  studentId: string
  classId: string
  className: string
  academicYearId: string
  academicYearName: string
  status: EnrollmentStatus
  startDate: string
  endDate: string | null
}
export interface StudentProfile { student: Student; guardians: GuardianLink[]; enrollments: Enrollment[]; current: Enrollment | null }

export interface StudentPage { items: StudentListItem[]; total: number; page: number; pageSize: number }
export interface ListParams { search?: string; status?: StudentStatus | ''; page?: number; pageSize?: number }

export interface StudentInput {
  admissionNumber?: string
  firstName: string
  middleName?: string | null
  lastName: string
  dateOfBirth?: string | null
  admittedOn?: string | null
}
export interface NewGuardianInput { fullName: string; phone?: string | null; email?: string | null }
export type LinkInput =
  | { guardianId: string; relationship: GuardianRelationship; isPrimaryContact?: boolean }
  | { guardian: NewGuardianInput; relationship: GuardianRelationship; isPrimaryContact?: boolean }

const base = '/api/students'

export function listStudents(params: ListParams, signal?: AbortSignal) {
  const query = new URLSearchParams()
  if (params.search?.trim()) query.set('search', params.search.trim())
  if (params.status) query.set('status', params.status)
  if (params.page) query.set('page', String(params.page))
  if (params.pageSize) query.set('pageSize', String(params.pageSize))
  const text = query.toString()
  return api<StudentPage>(`${base}${text ? `?${text}` : ''}`, { signal })
}
export const registerStudent = (input: StudentInput) => api<Student>(base, { method: 'POST', body: input })
export const getStudent = (id: string, signal?: AbortSignal) => api<StudentProfile>(`${base}/${id}`, { signal })
export const updateStudent = (id: string, input: Partial<StudentInput>) => api<Student>(`${base}/${id}`, { method: 'PATCH', body: input })
export const changeStudentStatus = (id: string, status: StudentStatus, effectiveDate?: string) =>
  api<{ student: Student; closedEnrollmentIds: string[] }>(`${base}/${id}/status`, { method: 'POST', body: { status, ...(effectiveDate ? { effectiveDate } : {}) } })

export const searchGuardians = (search: string, signal?: AbortSignal) =>
  api<{ guardians: Guardian[] }>(`/api/guardians?search=${encodeURIComponent(search)}`, { signal }).then((r) => r.guardians)
export const updateGuardian = (id: string, input: Partial<NewGuardianInput>) => api<Guardian>(`/api/guardians/${id}`, { method: 'PATCH', body: input })
export const linkGuardian = (studentId: string, input: LinkInput) =>
  api<{ guardian: Guardian; link: { relationship: GuardianRelationship; isPrimaryContact: boolean } }>(`${base}/${studentId}/guardians`, { method: 'POST', body: input })
export const updateGuardianLink = (studentId: string, guardianId: string, input: { relationship?: GuardianRelationship; isPrimaryContact?: boolean }) =>
  api(`${base}/${studentId}/guardians/${guardianId}`, { method: 'PATCH', body: input })
export const unlinkGuardian = (studentId: string, guardianId: string) => api(`${base}/${studentId}/guardians/${guardianId}`, { method: 'DELETE' })

export const enrollStudent = (studentId: string, input: { classId: string; academicYearId: string; startDate?: string }) =>
  api<Enrollment>(`${base}/${studentId}/enrollments`, { method: 'POST', body: input })
export const transferStudent = (studentId: string, input: { classId: string; effectiveDate?: string }) =>
  api<{ ended: Enrollment; created: Enrollment }>(`${base}/${studentId}/enrollments/transfer`, { method: 'POST', body: input })

export interface RosterEntry { enrollmentId: string; status: EnrollmentStatus; startDate: string; endDate: string | null; student: StudentSummary }
export const getRoster = (classId: string, academicYearId: string, signal?: AbortSignal) =>
  api<{ entries: RosterEntry[] }>(`/api/enrollments/roster?classId=${classId}&academicYearId=${academicYearId}`, { signal }).then((r) => r.entries)

export const fullName = (s: { firstName: string; middleName: string | null; lastName: string }) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ')
