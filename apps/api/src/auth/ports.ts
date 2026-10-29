/**
 * What the authentication logic needs from the database. The Prisma-backed
 * implementation lives elsewhere; the logic here is tested against an in-memory
 * fake, so it never depends on a particular database client.
 */
export type UserStatus = "INVITED" | "ACTIVE" | "DISABLED";
export type MembershipStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "ENDED";
export type SchoolStatus = "ACTIVE" | "SUSPENDED";

export interface UserRecord {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
}

export interface CredentialRecord {
  userId: string;
  passwordHash: string;
  algorithm: "argon2id" | "scrypt";
  failedLoginCount: number;
  lockedUntil: Date | null;
  /** True for a temporary password handed out by a school administrator: the person must choose their own first. */
  mustChangePassword: boolean;
}

export interface MembershipRecord {
  membershipId: string;
  schoolId: string;
  schoolName: string;
  schoolStatus: SchoolStatus;
  status: MembershipStatus;
  roles: string[];
}

export interface SessionRecord {
  id: string;
  userId: string;
  activeSchoolId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  csrfTokenHash: Buffer;
}

export interface NewSession {
  userId: string;
  tokenHash: Buffer;
  csrfTokenHash: Buffer;
  activeSchoolId: string | null;
  expiresAt: Date;
}

export interface AuditEventInput {
  schoolId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
}

export type RevokeReason = "logout" | "password_changed" | "admin_revoked" | "user_disabled" | "expired_cleanup";

export interface AuthRepository {
  findUserByEmail(email: string): Promise<{ user: UserRecord; credential: CredentialRecord | null } | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  findCredential(userId: string): Promise<CredentialRecord | null>;
  /** All memberships of the user (any status), with their roles and school status. */
  listMemberships(userId: string): Promise<MembershipRecord[]>;
  recordFailedLogin(userId: string, lockUntil: Date | null): Promise<void>;
  recordSuccessfulLogin(userId: string): Promise<void>;
  /**
   * Stores a new hash. The must-change flag is only cleared when `clearMustChange` is true (the person
   * chose their own password); a silent hash upgrade at login must never clear it.
   */
  replacePasswordHash(userId: string, hash: string, algorithm: "argon2id" | "scrypt", changedAt: Date, clearMustChange?: boolean): Promise<void>;
  createSession(session: NewSession): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: Buffer): Promise<SessionRecord | null>;
  touchSession(sessionId: string, at: Date): Promise<void>;
  setActiveSchool(sessionId: string, schoolId: string): Promise<void>;
  revokeSession(sessionId: string, at: Date, reason: RevokeReason): Promise<void>;
  /** Revoke every live session of a user, optionally keeping one. Returns how many were revoked. */
  revokeUserSessions(userId: string, at: Date, reason: RevokeReason, exceptSessionId?: string): Promise<number>;
  appendAudit(event: AuditEventInput): Promise<void>;
}
