import { api } from '../../lib/api'

export type ClassLevel = 'NURSERY' | 'KINDERGARTEN' | 'PRIMARY' | 'JHS'

export const CLASS_LEVELS: { value: ClassLevel; label: string }[] = [
  { value: 'NURSERY', label: 'Nursery' },
  { value: 'KINDERGARTEN', label: 'KG' },
  { value: 'PRIMARY', label: 'Primary' },
  { value: 'JHS', label: 'JHS' },
]

export const levelLabel = (level: ClassLevel) => CLASS_LEVELS.find((l) => l.value === level)?.label ?? level

export interface SchoolClass {
  id: string
  name: string
  level: ClassLevel
  sortOrder: number
  isActive: boolean
}

export interface ClassInput { name: string; level: ClassLevel; sortOrder?: number }

const base = '/api/classes'

export const listClasses = (signal?: AbortSignal) => api<{ classes: SchoolClass[] }>(base, { signal }).then((r) => r.classes)
export const createClass = (input: ClassInput) => api<SchoolClass>(base, { method: 'POST', body: input })
export const updateClass = (id: string, input: Partial<ClassInput> & { isActive?: boolean }) =>
  api<SchoolClass>(`${base}/${id}`, { method: 'PATCH', body: input })
export const reorderClasses = (classIds: string[]) =>
  api<{ classes: SchoolClass[] }>(`${base}/order`, { method: 'PUT', body: { classIds } }).then((r) => r.classes)
