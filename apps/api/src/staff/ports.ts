import type { AuditEventInput } from "../auth/ports.js";

/** Stored values; they mirror the database enums exactly. */
export const STAFF_ROLES = ["OWNER", "HEADTEACHER", "ADMINISTRATOR", "TEACHER", "BURSAR"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_STATUSES = ["INVITED", "ACTIVE", "SUSPENDED", "ENDED"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** What the repository returns. `userId` and `mustChangePassword` are internal; they are not sent to the browser. */
export interface StaffRecord {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  status: StaffStatus;
  roles: StaffRole[];
  /** ISO timestamps. */
  endedAt: string | null;
  createdAt: string;
  /** A temporary password is still waiting to be replaced: the person has not chosen their own yet. */
  mustChangePassword: boolean;
}

export interface NewStaffAccount {
  email: string;
  fullName: string;
  roles: StaffRole[];
  /** Hash only. The clear temporary password never reaches the repository. */
  passwordHash: string;
  algorithm: "argon2id" | "scrypt";
}

/**
 * Every method takes the school id FIRST and applies it to every query; the id comes from the
 * verified session, never from the request. A membership in another school is indistinguishable
 * from a missing one (null / false). Nothing is ever deleted except a role row (a role being taken
 * away); memberships and users are kept as history.
 *
 * Methods that change several rows are atomic: everything is saved, or nothing is.
 */
export interface StaffRepository {
  listStaff(schoolId: string): Promise<StaffRecord[]>;
  findStaff(schoolId: string, membershipId: string): Promise<StaffRecord | null>;
  /** True when ANY account (in any school) already uses this e-mail address. */
  emailInUse(email: string): Promise<boolean>;
  /**
   * Atomic: creates the user (ACTIVE), its credential (flagged must-change), an ACTIVE membership in
   * this school and its roles, or none of them. Throws RepositoryConflict("duplicate") if the e-mail
   * was taken in the meantime.
   */
  createStaffAccount(schoolId: string, input: NewStaffAccount): Promise<StaffRecord>;
  /**
   * Atomic: replaces the roles of a membership. With `keepAnotherOwner`, throws
   * RepositoryConflict("overlap") instead of leaving the school with no active owner.
   */
  setRoles(schoolId: string, membershipId: string, roles: StaffRole[], keepAnotherOwner: boolean): Promise<StaffRecord | null>;
  /** Sets the status (ENDED also stamps `ended_at`; any other status clears it). Same `keepAnotherOwner` rule as setRoles. */
  setStatus(schoolId: string, membershipId: string, status: StaffStatus, at: Date, keepAnotherOwner: boolean): Promise<StaffRecord | null>;
  /** Number of ACTIVE memberships in the school (other than `exceptMembershipId`) that hold the OWNER role. */
  countActiveOwners(schoolId: string, exceptMembershipId: string): Promise<number>;
  /** How many memberships the person behind this membership has in OTHER schools. */
  countOtherSchoolMemberships(schoolId: string, membershipId: string): Promise<number>;
  /**
   * Atomic: stores the new temporary password hash (flagged must-change, lock-out cleared) and
   * revokes every live session of that user. Returns how many sessions were revoked, or null when
   * the membership is not in this school.
   */
  setTemporaryPassword(schoolId: string, membershipId: string, hash: string, algorithm: "argon2id" | "scrypt", at: Date): Promise<number | null>;
  appendAudit(event: AuditEventInput): Promise<void>;
}
