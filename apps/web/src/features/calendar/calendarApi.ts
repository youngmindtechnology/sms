import { api } from '../../lib/api'

export type PeriodStatus = 'PLANNED' | 'ACTIVE' | 'CLOSED'

export interface AcademicYear {
  id: string
  name: string
  startDate: string
  endDate: string
  status: PeriodStatus
}

export interface Term {
  id: string
  academicYearId: string
  name: string
  sequence: number
  startDate: string
  endDate: string
  status: PeriodStatus
}

export interface YearInput { name: string; startDate: string; endDate: string }
export interface TermInput { name: string; sequence?: number; startDate: string; endDate: string }

const base = '/api/academic-years'

export const listYears = (signal?: AbortSignal) => api<{ years: AcademicYear[] }>(base, { signal }).then((r) => r.years)
export const createYear = (input: YearInput) => api<AcademicYear>(base, { method: 'POST', body: input })
export const updateYear = (id: string, input: Partial<YearInput>) => api<AcademicYear>(`${base}/${id}`, { method: 'PATCH', body: input })
export const activateYear = (id: string) => api<AcademicYear>(`${base}/${id}/activate`, { method: 'POST' })
export const closeYear = (id: string) => api<AcademicYear>(`${base}/${id}/close`, { method: 'POST' })

export const listTerms = (yearId: string, signal?: AbortSignal) =>
  api<{ terms: Term[] }>(`${base}/${yearId}/terms`, { signal }).then((r) => r.terms)
export const createTerm = (yearId: string, input: TermInput) => api<Term>(`${base}/${yearId}/terms`, { method: 'POST', body: input })
export const updateTerm = (yearId: string, termId: string, input: Partial<TermInput>) =>
  api<Term>(`${base}/${yearId}/terms/${termId}`, { method: 'PATCH', body: input })
export const activateTerm = (yearId: string, termId: string) => api<Term>(`${base}/${yearId}/terms/${termId}/activate`, { method: 'POST' })
export const closeTerm = (yearId: string, termId: string) => api<Term>(`${base}/${yearId}/terms/${termId}/close`, { method: 'POST' })
