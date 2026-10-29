import type { StudentStatus } from './studentsApi'

/** Badge colour for each student status. */
export const STATUS_VARIANT: Record<StudentStatus, 'active' | 'closed' | 'planned'> = {
  ACTIVE: 'active',
  WITHDRAWN: 'closed',
  TRANSFERRED_OUT: 'closed',
  GRADUATED: 'planned',
}
