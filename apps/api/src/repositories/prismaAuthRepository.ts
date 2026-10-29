import type { PrismaClient } from "@ymt/database";
import type {
  AuditEventInput,
  AuthRepository,
  CredentialRecord,
  MembershipRecord,
  NewSession,
  RevokeReason,
  SessionRecord,
  UserRecord,
} from "../auth/ports.js";

/**
 * PostgreSQL-backed AuthRepository. It only reads and writes the tables the
 * authentication logic needs. Passwords and tokens never pass through here in
 * the clear: hashes in, hashes out.
 */
export function createPrismaAuthRepository(db: PrismaClient): AuthRepository {
  // Prisma wants plain bytes (Uint8Array over an ArrayBuffer); a Node Buffer's type is wider.
  const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

  const toCredential = (c: {
    userId: string; passwordHash: string; algorithm: string; failedLoginCount: number; lockedUntil: Date | null; mustChangePassword: boolean;
  }): CredentialRecord => ({
    userId: c.userId,
    passwordHash: c.passwordHash,
    algorithm: c.algorithm === "scrypt" ? "scrypt" : "argon2id",
    failedLoginCount: c.failedLoginCount,
    lockedUntil: c.lockedUntil,
    mustChangePassword: c.mustChangePassword,
  });

  const toUser = (u: { id: string; email: string; fullName: string; status: string }): UserRecord => ({
    id: u.id, email: u.email, fullName: u.fullName, status: u.status as UserRecord["status"],
  });

  const toSession = (s: {
    id: string; userId: string; activeSchoolId: string | null; createdAt: Date; lastSeenAt: Date;
    expiresAt: Date; revokedAt: Date | null; csrfTokenHash: Uint8Array;
  }): SessionRecord => ({
    id: s.id, userId: s.userId, activeSchoolId: s.activeSchoolId, createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, revokedAt: s.revokedAt,
    csrfTokenHash: Buffer.from(s.csrfTokenHash),
  });

  return {
    async findUserByEmail(email) {
      const row = await db.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        include: { credential: true },
      });
      if (!row) return null;
      return { user: toUser(row), credential: row.credential ? toCredential(row.credential) : null };
    },

    async findUserById(id) {
      const row = await db.user.findUnique({ where: { id } });
      return row ? toUser(row) : null;
    },

    async findCredential(userId) {
      const row = await db.userCredential.findUnique({ where: { userId } });
      return row ? toCredential(row) : null;
    },

    async listMemberships(userId): Promise<MembershipRecord[]> {
      const rows = await db.schoolMembership.findMany({
        where: { userId },
        include: { school: true, roles: true },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((m) => ({
        membershipId: m.id,
        schoolId: m.schoolId,
        schoolName: m.school.name,
        schoolStatus: m.school.status,
        status: m.status,
        roles: m.roles.map((r) => r.role),
      }));
    },

    async recordFailedLogin(userId, lockUntil) {
      await db.userCredential.update({
        where: { userId },
        data: { failedLoginCount: { increment: 1 }, ...(lockUntil ? { lockedUntil: lockUntil } : {}) },
      });
    },

    async recordSuccessfulLogin(userId) {
      await db.userCredential.update({ where: { userId }, data: { failedLoginCount: 0, lockedUntil: null } });
    },

    async replacePasswordHash(userId, hash, algorithm, changedAt, clearMustChange = false) {
      await db.userCredential.update({
        where: { userId },
        data: { passwordHash: hash, algorithm, passwordChangedAt: changedAt, ...(clearMustChange ? { mustChangePassword: false } : {}) },
      });
    },

    async createSession(input: NewSession) {
      const row = await db.session.create({
        data: {
          userId: input.userId,
          tokenHash: bytes(input.tokenHash),
          csrfTokenHash: bytes(input.csrfTokenHash),
          activeSchoolId: input.activeSchoolId,
          expiresAt: input.expiresAt,
        },
      });
      return toSession(row);
    },

    async findSessionByTokenHash(tokenHash) {
      const row = await db.session.findUnique({ where: { tokenHash: bytes(tokenHash) } });
      return row ? toSession(row) : null;
    },

    async touchSession(sessionId, at) {
      await db.session.update({ where: { id: sessionId }, data: { lastSeenAt: at } });
    },

    async setActiveSchool(sessionId, schoolId) {
      await db.session.update({ where: { id: sessionId }, data: { activeSchoolId: schoolId } });
    },

    async revokeSession(sessionId, at, reason: RevokeReason) {
      await db.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: at, revokedReason: reason },
      });
    },

    async revokeUserSessions(userId, at, reason: RevokeReason, exceptSessionId) {
      const result = await db.session.updateMany({
        where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
        data: { revokedAt: at, revokedReason: reason },
      });
      return result.count;
    },

    async appendAudit(event: AuditEventInput) {
      await db.auditEvent.create({
        data: {
          schoolId: event.schoolId,
          actorUserId: event.actorUserId,
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId,
          metadata: event.metadata as object,
        },
      });
    },
  };
}
