import { assertAuditSafe } from "../auth/audit.js";
import type { GuardianLink, GuardianRecord, StudentRecord, StudentRepository } from "./ports.js";

/**
 * The verified caller. All fields come from the server-side session, never from the request.
 * `canViewSensitive` is true only for roles holding students:sensitive; when it is missing the
 * caller is treated as NOT allowed (fail closed).
 */
export interface Actor { schoolId: string; userId: string; canViewSensitive?: boolean }

/**
 * Sensitive fields: a student's date of birth and a guardian's phone number and e-mail address.
 * Every response that carries them goes through these helpers, so a caller without
 * students:sensitive receives null in their place (the shape stays the same) and never the value.
 */
export const redactStudent = (student: StudentRecord, actor: Actor): StudentRecord =>
  actor.canViewSensitive === true ? student : { ...student, dateOfBirth: null };
export const redactGuardian = <T extends GuardianRecord | GuardianLink>(guardian: T, actor: Actor): T =>
  actor.canViewSensitive === true ? guardian : { ...guardian, phone: null, email: null };

export type StudentErrorCode =
  | "validation_error"
  | "not_found"
  | "duplicate_admission_number"
  | "invalid_status_change"
  | "student_not_active"
  | "already_linked"
  | "already_enrolled"
  | "year_closed"
  | "class_inactive"
  | "no_current_enrollment";

export type Result<T> = { ok: true; value: T } | { ok: false; error: StudentErrorCode; fields?: Record<string, string> };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: StudentErrorCode, fields?: Record<string, string>): Result<never> => ({ ok: false, error, fields });

/** Today as a plain calendar date. The platform serves Ghana (UTC+0 all year), so UTC is the school's day. */
export const todayOf = (now: () => Date) => now().toISOString().slice(0, 10);

/**
 * Audit events carry ids, status words and the NAMES OF CHANGED FIELDS only. Never names, dates of
 * birth, phone numbers, e-mail addresses or admission numbers. assertAuditSafe also refuses secrets.
 */
export function makeAudit(repo: StudentRepository, actor: Actor) {
  return async (action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) => {
    assertAuditSafe(metadata);
    await repo.appendAudit({ schoolId: actor.schoolId, actorUserId: actor.userId, action, entityType, entityId, metadata });
  };
}

/** "2026-03-01" -> "2026-02-28". Pure calendar arithmetic on UTC dates. */
export function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
