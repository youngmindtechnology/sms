import { ApiError } from '../../lib/api'
import { describeError } from '../calendar/messages'

/** Class-specific wording first, then the shared messages. Never shows server internals. */
export function describeClassError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'order_mismatch') return 'The class list changed since you opened this page. It has been reloaded; try again.'
    if (error.code === 'duplicate_name') return 'A class with this name already exists.'
  }
  return describeError(error)
}
