import { ApiError } from '../../lib/api'

const MESSAGES: Record<string, string> = {
  validation_error: 'Please correct the highlighted fields.',
  invalid_request: 'Please check what you entered and try again.',
  not_found: 'That record no longer exists. Reload the page.',
  duplicate_name: 'That name is already in use.',
  duplicate_sequence: 'That term number is already in use in this year.',
  dates_overlap: 'These dates overlap another period.',
  terms_outside_year: 'Existing terms would fall outside the new dates.',
  outside_year: 'A term must fall inside its academic year.',
  period_closed: 'A closed period cannot be changed.',
  already_active: 'This period is already current.',
  not_active: 'Only the current period can be closed.',
  year_not_active: 'Make the academic year current before making one of its terms current.',
  insufficient_permission: "Your role isn't allowed to make this change.",
  school_required: 'Choose a school first.',
  bad_csrf: 'Your session needs refreshing. Reload the page and try again.',
  too_many_requests: 'Too many requests. Wait a moment and try again.',
}

/** A safe, human message for any failure. Never shows server internals. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return "Can't reach the server. Check your connection and try again."
    return MESSAGES[error.code] ?? 'Something went wrong. Please try again.'
  }
  return 'Something went wrong. Please try again.'
}

/** Field-level messages from a 400 `validation_error` or a 409 rule, keyed by field name. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (error instanceof ApiError) {
    const fields = (error.details as { fields?: unknown } | null)?.fields
    if (fields && typeof fields === 'object') {
      return Object.fromEntries(Object.entries(fields).filter((e): e is [string, string] => typeof e[1] === 'string'))
    }
  }
  return {}
}
