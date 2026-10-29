import { ApiError } from '../../lib/api'
import { describeError } from '../calendar/messages'

const MESSAGES: Record<string, string> = {
  duplicate_admission_number: 'This admission number is already used in your school.',
  invalid_status_change: "That status change isn't allowed. A student who has left must be reactivated first.",
  student_not_active: 'Only active students can be enrolled or moved. Reactivate the student first.',
  already_linked: 'This guardian is already linked to this student.',
  already_enrolled: 'This student is already in a class. Use "Change class" to move them.',
  year_closed: 'This academic year is closed, so it can no longer receive enrollments.',
  class_inactive: 'This class is inactive. Choose an active class.',
  no_current_enrollment: 'This student has no current enrollment to change.',
  not_found: 'That record no longer exists. Reload the page.',
}

/** Student-specific wording first, then the shared messages. Never shows server internals. */
export function describeStudentError(error: unknown): string {
  if (error instanceof ApiError && MESSAGES[error.code]) return MESSAGES[error.code]!
  return describeError(error)
}
