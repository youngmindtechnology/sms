/** Shared types for the dashboard and its sample data. */

export type SchoolLevel = 'Nursery' | 'Kindergarten' | 'Primary' | 'JHS'

export interface EnrollmentByLevel {
  level: SchoolLevel
  students: number
  classes: number
}

export interface FeeSummary {
  /** Total fees billed for the term, in Ghana cedis. */
  billed: number
  /** Total fees collected so far, in Ghana cedis. */
  collected: number
}

export type ActivityKind = 'Enrollment' | 'Payment' | 'Academics' | 'Staff'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  description: string
  /** Human-readable, e.g. "2 hours ago". Static in sample data. */
  timeLabel: string
}

/** Everything the dashboard needs. Later phases will fill this from an API. */
export interface DashboardSample {
  schoolName: string
  termLabel: string
  enrollment: EnrollmentByLevel[]
  fees: FeeSummary
  recentActivity: ActivityItem[]
}

/** One summary card, already formatted for display. */
export interface SummaryStat {
  id: string
  label: string
  value: string
  helper: string
}
