import { api } from '../../lib/api'
import type { SchoolClass } from '../classes/classesApi'

export interface Subject {
  id: string
  classId: string
  name: string
  code: string | null
  isActive: boolean
}

export type AssignmentStatus = 'ACTIVE' | 'ENDED'

/** A teacher is a membership id and a name only. The server sends no user id or e-mail. */
export interface Assignment {
  id: string
  subjectId: string
  academicYearId: string
  academicYearName: string
  teacherMembershipId: string
  teacherName: string
  status: AssignmentStatus
  endedAt: string | null
  createdAt: string
}

export interface SubjectWithTeachers extends Subject { teachers: Assignment[] }

export interface ClassSubjects {
  class: Pick<SchoolClass, 'id' | 'name' | 'isActive'>
  academicYear: { id: string; name: string; status: 'PLANNED' | 'ACTIVE' | 'CLOSED' } | null
  subjects: SubjectWithTeachers[]
}

export interface EligibleTeacher { membershipId: string; fullName: string }
export interface SubjectInput { name: string; code: string }

export const listSubjects = (classId: string, academicYearId: string | null, signal?: AbortSignal) => {
  const query = new URLSearchParams({ classId, ...(academicYearId ? { academicYearId } : {}) })
  return api<ClassSubjects>(`/api/subjects?${query.toString()}`, { signal })
}
/** A blank code means "no code": it is sent as null. */
export const createSubject = (classId: string, input: SubjectInput) =>
  api<Subject>('/api/subjects', { method: 'POST', body: { classId, name: input.name, code: input.code.trim() === '' ? null : input.code } })
export const updateSubject = (id: string, patch: { name?: string; code?: string | null; isActive?: boolean }) =>
  api<Subject>(`/api/subjects/${id}`, { method: 'PATCH', body: patch })
export const listEligibleTeachers = (signal?: AbortSignal) =>
  api<{ teachers: EligibleTeacher[] }>('/api/teaching-assignments/eligible-teachers', { signal }).then((r) => r.teachers)
export const assignTeacher = (subjectId: string, academicYearId: string, teacherMembershipId: string) =>
  api<Assignment>(`/api/subjects/${subjectId}/assignments`, { method: 'POST', body: { academicYearId, teacherMembershipId } })
export const replaceTeacher = (assignmentId: string, teacherMembershipId: string) =>
  api<{ ended: Assignment; created: Assignment }>(`/api/teaching-assignments/${assignmentId}/replace`, { method: 'POST', body: { teacherMembershipId } })
export const endAssignment = (assignmentId: string) =>
  api<Assignment>(`/api/teaching-assignments/${assignmentId}/end`, { method: 'POST', body: {} })
