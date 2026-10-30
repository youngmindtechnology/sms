import { ApiError } from '../../lib/api'
import { describeError } from '../calendar/messages'

const MESSAGES: Record<string, string> = {
  duplicate_name: 'This class already has a subject with this name.',
  duplicate_code: 'This class already has a subject with this code.',
  class_inactive: 'This class is inactive. Choose an active class.',
  subject_inactive: 'This subject is inactive. Reactivate it before assigning teachers.',
  year_closed: 'This academic year is closed, so teachers can no longer be assigned to it.',
  teacher_not_eligible: 'Only active teachers of your school can be assigned. Reload the page to see the current list.',
  already_assigned: 'This teacher is already assigned to this subject for that year.',
  assignment_ended: 'This assignment has already ended. Reload the page to see the current state.',
  not_found: 'That record no longer exists. Reload the page.',
}

/** Subject-specific wording first, then the shared messages. Never shows server internals. */
export function describeSubjectError(error: unknown): string {
  if (error instanceof ApiError && MESSAGES[error.code]) return MESSAGES[error.code]!
  return describeError(error)
}
