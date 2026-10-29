import { ApiError } from '../../lib/api'
import { describeError } from '../calendar/messages'

/** Staff wording first, then the shared messages. Never shows server internals. */
export function describeStaffError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'role_not_allowed': return "You can't change this person, or give one of these roles."
      case 'cannot_change_own_access': return "You can't change your own roles, status or password here."
      case 'last_owner': return 'A school must keep at least one active Owner.'
      case 'membership_ended': return "This person's membership has ended. Reactivate it first."
      case 'membership_not_active': return 'Only active people can have their password reset.'
      case 'invalid_status_change': return "That status change isn't allowed."
      case 'shared_account': return "This person also belongs to another school, so their password can't be reset from here."
      case 'email_in_use': return "This email address can't be used for a new account."
      case 'password_change_required': return 'Choose your own password first.'
    }
  }
  return describeError(error)
}
