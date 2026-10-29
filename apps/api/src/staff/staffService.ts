import { RepositoryConflict } from "../academic/ports.js";
import { assertAuditSafe } from "../auth/audit.js";
import { normaliseEmail } from "../auth/authService.js";
import { hashPassword } from "../auth/password.js";
import { cleanText } from "../students/validation.js";
import { STAFF_ROLES, type StaffRecord, type StaffRepository, type StaffRole, type StaffStatus } from "./ports.js";
import { generateTemporaryPassword } from "./tempPassword.js";

/** The verified caller. All fields come from the server-side session, never from the request. */
export interface StaffActor { schoolId: string; userId: string; roles: readonly string[] }

export type StaffErrorCode =
  | "validation_error"
  | "not_found"
  | "role_not_allowed"
  | "cannot_change_own_access"
  | "email_in_use"
  | "last_owner"
  | "membership_ended"
  | "membership_not_active"
  | "invalid_status_change"
  | "shared_account";

export type Result<T> = { ok: true; value: T } | { ok: false; error: StaffErrorCode; fields?: Record<string, string> };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: StaffErrorCode, fields?: Record<string, string>): Result<never> => ({ ok: false, error, fields });

/**
 * Who may manage which roles (product decision):
 *  - OWNER manages every role.
 *  - ADMINISTRATOR manages TEACHER and BURSAR memberships only.
 *  - Nobody else manages staff. (HEADTEACHER, TEACHER and BURSAR do not hold staff:manage at all.)
 * To act on a person the caller must be able to manage EVERY role the person holds now, and every role
 * they are being given. So an Administrator can never touch an Owner, a Headteacher or another
 * Administrator, and can never hand out those roles. Nobody can change their own roles or status.
 */
const MANAGEABLE: Partial<Record<string, readonly StaffRole[]>> = {
  OWNER: STAFF_ROLES,
  ADMINISTRATOR: ["TEACHER", "BURSAR"],
};

export function assignableRoles(actorRoles: readonly string[]): StaffRole[] {
  const granted = new Set<StaffRole>();
  for (const role of actorRoles) for (const manageable of MANAGEABLE[role] ?? []) granted.add(manageable);
  return STAFF_ROLES.filter((role) => granted.has(role));
}

/** A status change can only target these; INVITED is never chosen through the API. */
const SETTABLE: readonly StaffStatus[] = ["ACTIVE", "SUSPENDED", "ENDED"];
const TRANSITIONS: Record<StaffStatus, readonly StaffStatus[]> = {
  INVITED: ["ACTIVE", "ENDED"],
  ACTIVE: ["SUSPENDED", "ENDED"],
  SUSPENDED: ["ACTIVE", "ENDED"],
  ENDED: ["ACTIVE"],
};

/** What the browser receives: no user id, no credential data. */
export interface StaffMember {
  membershipId: string;
  email: string;
  fullName: string;
  status: StaffStatus;
  roles: StaffRole[];
  endedAt: string | null;
  createdAt: string;
  /** Still using the temporary password: has not signed in and chosen their own yet. */
  awaitingFirstSignIn: boolean;
  isYou: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface StaffDeps {
  hash?: (password: string) => Promise<{ hash: string; algorithm: "argon2id" | "scrypt" }>;
  now?: () => Date;
}

export function createStaffService(repo: StaffRepository, deps: StaffDeps = {}) {
  const hash = deps.hash ?? ((password: string) => hashPassword(password));
  const now = deps.now ?? (() => new Date());

  const toMember = (record: StaffRecord, actor: StaffActor): StaffMember => ({
    membershipId: record.membershipId,
    email: record.email,
    fullName: record.fullName,
    status: record.status,
    roles: record.roles,
    endedAt: record.endedAt,
    createdAt: record.createdAt,
    awaitingFirstSignIn: record.mustChangePassword && record.status !== "ENDED",
    isYou: record.userId === actor.userId,
  });

  /** Audit events carry ids, role names and status words only: no e-mail, name, password or hash. */
  async function audit(actor: StaffActor, action: string, membershipId: string, metadata: Record<string, unknown>) {
    assertAuditSafe(metadata);
    await repo.appendAudit({ schoolId: actor.schoolId, actorUserId: actor.userId, action, entityType: "membership", entityId: membershipId, metadata });
  }

  function readRoles(value: unknown, errors: Record<string, string>): StaffRole[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > STAFF_ROLES.length) { errors.roles = "Choose at least one role."; return null; }
    const roles: StaffRole[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !(STAFF_ROLES as readonly string[]).includes(item)) { errors.roles = "Choose roles from the list."; return null; }
      if (!roles.includes(item as StaffRole)) roles.push(item as StaffRole);
    }
    return STAFF_ROLES.filter((role) => roles.includes(role));
  }

  const manages = (actor: StaffActor, roles: readonly StaffRole[]) => {
    const allowed = assignableRoles(actor.roles);
    return roles.every((role) => allowed.includes(role));
  };

  /** Shared first steps of every change to an existing person. Order matters: authorise before validating. */
  async function target(actor: StaffActor, membershipId: string, options: { allowEnded?: boolean } = {}): Promise<Result<StaffRecord>> {
    const found = await repo.findStaff(actor.schoolId, membershipId);
    if (!found) return fail("not_found");
    if (found.userId === actor.userId) return fail("cannot_change_own_access");
    if (!manages(actor, found.roles)) return fail("role_not_allowed");
    if (found.status === "ENDED" && !options.allowEnded) return fail("membership_ended");
    return ok(found);
  }

  async function list(actor: StaffActor): Promise<Result<{ staff: StaffMember[]; assignableRoles: StaffRole[] }>> {
    const records = await repo.listStaff(actor.schoolId);
    return ok({ staff: records.map((r) => toMember(r, actor)), assignableRoles: assignableRoles(actor.roles) });
  }

  async function create(actor: StaffActor, input: { email?: unknown; fullName?: unknown; roles?: unknown }): Promise<Result<{ staff: StaffMember; temporaryPassword: string }>> {
    const errors: Record<string, string> = {};
    let email: string | null = null;
    if (typeof input.email !== "string") errors.email = "Enter an email address.";
    else {
      email = normaliseEmail(input.email);
      if (email.length > 254 || !EMAIL.test(email) || CONTROL.test(email)) { errors.email = "Enter a valid email address."; email = null; }
    }
    const fullName = cleanText(input.fullName, "fullName", "the full name", 200, errors);
    const roles = readRoles(input.roles, errors);
    if (!email || !fullName || !roles || Object.keys(errors).length) return fail("validation_error", errors);
    if (!manages(actor, roles)) return fail("role_not_allowed", { roles: "You can't give one or more of these roles." });

    // Deliberately the same answer whether the address is used in this school or another one.
    if (await repo.emailInUse(email)) return fail("email_in_use", { email: "This email address can't be used for a new account." });

    const temporaryPassword = generateTemporaryPassword(email);
    const { hash: passwordHash, algorithm } = await hash(temporaryPassword);
    let created: StaffRecord;
    try {
      created = await repo.createStaffAccount(actor.schoolId, { email, fullName, roles, passwordHash, algorithm });
    } catch (error) {
      if (error instanceof RepositoryConflict) return fail("email_in_use", { email: "This email address can't be used for a new account." });
      throw error;
    }
    await audit(actor, "staff.created", created.membershipId, { roles });
    return ok({ staff: toMember(created, actor), temporaryPassword });
  }

  async function updateRoles(actor: StaffActor, membershipId: string, input: { roles?: unknown }): Promise<Result<StaffMember>> {
    const current = await target(actor, membershipId);
    if (!current.ok) return current;
    const errors: Record<string, string> = {};
    const roles = readRoles(input.roles, errors);
    if (!roles) return fail("validation_error", errors);
    if (!manages(actor, roles)) return fail("role_not_allowed", { roles: "You can't give one or more of these roles." });
    const before = current.value;
    if (before.roles.length === roles.length && before.roles.every((r) => roles.includes(r))) return fail("validation_error", { roles: "Nothing to change." });

    const losesOwner = before.status === "ACTIVE" && before.roles.includes("OWNER") && !roles.includes("OWNER");
    if (losesOwner && (await repo.countActiveOwners(actor.schoolId, membershipId)) === 0) return fail("last_owner");
    let updated: StaffRecord | null;
    try {
      updated = await repo.setRoles(actor.schoolId, membershipId, roles, losesOwner);
    } catch (error) {
      if (error instanceof RepositoryConflict) return fail("last_owner");
      throw error;
    }
    if (!updated) return fail("not_found");
    await audit(actor, "staff.roles_changed", membershipId, { from: before.roles, to: roles });
    return ok(toMember(updated, actor));
  }

  async function changeStatus(actor: StaffActor, membershipId: string, input: { status?: unknown }): Promise<Result<StaffMember>> {
    const current = await target(actor, membershipId, { allowEnded: true });
    if (!current.ok) return current;
    const wanted = input.status;
    if (typeof wanted !== "string" || !(SETTABLE as readonly string[]).includes(wanted)) return fail("validation_error", { status: "Choose Active, Suspended or Ended." });
    const next = wanted as StaffStatus;
    const before = current.value;
    if (!TRANSITIONS[before.status].includes(next)) {
      return fail("invalid_status_change", { status: before.status === next ? "The person already has this status." : "That status change isn't allowed." });
    }

    const losesOwner = before.status === "ACTIVE" && before.roles.includes("OWNER") && next !== "ACTIVE";
    if (losesOwner && (await repo.countActiveOwners(actor.schoolId, membershipId)) === 0) return fail("last_owner");
    let updated: StaffRecord | null;
    try {
      updated = await repo.setStatus(actor.schoolId, membershipId, next, now(), losesOwner);
    } catch (error) {
      if (error instanceof RepositoryConflict) return fail("last_owner");
      throw error;
    }
    if (!updated) return fail("not_found");
    await audit(actor, "staff.status_changed", membershipId, { from: before.status, to: next });
    return ok(toMember(updated, actor));
  }

  /**
   * Gives the person a new temporary password (for someone who forgot theirs) and ends all their
   * sessions. A password belongs to the whole account, so this is refused when the person also
   * belongs to another school: that school's administrators must not be able to take the account over.
   */
  async function resetPassword(actor: StaffActor, membershipId: string): Promise<Result<{ staff: StaffMember; temporaryPassword: string }>> {
    const current = await target(actor, membershipId);
    if (!current.ok) return current;
    if (current.value.status !== "ACTIVE") return fail("membership_not_active");
    if ((await repo.countOtherSchoolMemberships(actor.schoolId, membershipId)) > 0) return fail("shared_account");

    const temporaryPassword = generateTemporaryPassword(current.value.email);
    const { hash: passwordHash, algorithm } = await hash(temporaryPassword);
    const revoked = await repo.setTemporaryPassword(actor.schoolId, membershipId, passwordHash, algorithm, now());
    if (revoked === null) return fail("not_found");
    await audit(actor, "staff.password_reset", membershipId, { sessionsRevoked: revoked });
    const fresh = await repo.findStaff(actor.schoolId, membershipId);
    if (!fresh) return fail("not_found");
    return ok({ staff: toMember(fresh, actor), temporaryPassword });
  }

  return { list, create, updateRoles, changeStatus, resetPassword };
}

export type StaffService = ReturnType<typeof createStaffService>;
