import type { PrismaClient } from "@ymt/database";
import { RepositoryConflict } from "../academic/ports.js";
import type { AuditEventInput } from "../auth/ports.js";
import { STAFF_ROLES, type NewStaffAccount, type StaffRecord, type StaffRepository, type StaffRole, type StaffStatus } from "../staff/ports.js";

type Row = {
  id: string; userId: string; status: string; endedAt: Date | null; createdAt: Date;
  user: { email: string; fullName: string; credential: { mustChangePassword: boolean } | null };
  roles: Array<{ role: string }>;
};

/** Only these columns are ever read from the user and credential: never the password hash. */
const include = {
  user: { select: { email: true, fullName: true, credential: { select: { mustChangePassword: true } } } },
  roles: { select: { role: true } },
} as const;

const toRecord = (m: Row): StaffRecord => ({
  membershipId: m.id,
  userId: m.userId,
  email: m.user.email,
  fullName: m.user.fullName,
  status: m.status as StaffStatus,
  roles: STAFF_ROLES.filter((role) => m.roles.some((r) => r.role === role)),
  endedAt: m.endedAt ? m.endedAt.toISOString() : null,
  createdAt: m.createdAt.toISOString(),
  mustChangePassword: m.user.credential?.mustChangePassword ?? false,
});

/** A unique-index violation (P2002) becomes a clean conflict; nothing from the original error is kept. */
function translate(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === "P2002") throw new RepositoryConflict("duplicate");
  throw error;
}

/**
 * PostgreSQL-backed staff management. Every query includes the school id. Memberships and users are
 * never deleted; the only rows removed are role rows (a role being taken away).
 *
 * Changes that could leave a school without an active owner first LOCK the school's active
 * memberships (SELECT ... FOR UPDATE), so two owners demoting each other at the same moment are
 * handled one after the other and the second one is refused.
 */
export function createPrismaStaffRepository(db: PrismaClient): StaffRepository {
  type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

  async function otherActiveOwners(tx: Tx, schoolId: string, exceptMembershipId: string) {
    return tx.schoolMembership.count({
      where: {
        schoolId, id: { not: exceptMembershipId }, status: "ACTIVE", user: { status: "ACTIVE" },
        roles: { some: { role: "OWNER" } },
      },
    });
  }

  async function lockActiveMemberships(tx: Tx, schoolId: string) {
    await tx.$queryRaw`SELECT id FROM school_memberships WHERE school_id = ${schoolId}::uuid AND status = 'ACTIVE' FOR UPDATE`;
  }

  return {
    async listStaff(schoolId) {
      const rows = await db.schoolMembership.findMany({ where: { schoolId }, include, orderBy: [{ user: { fullName: "asc" } }, { id: "asc" }] });
      return rows.map(toRecord);
    },

    async findStaff(schoolId, membershipId) {
      const row = await db.schoolMembership.findFirst({ where: { id: membershipId, schoolId }, include });
      return row ? toRecord(row) : null;
    },

    async emailInUse(email) {
      return (await db.user.count({ where: { email } })) > 0;
    },

    async createStaffAccount(schoolId, input: NewStaffAccount) {
      try {
        return await db.$transaction(async (tx) => {
          const user = await tx.user.create({ data: { email: input.email, fullName: input.fullName, status: "ACTIVE" }, select: { id: true } });
          await tx.userCredential.create({ data: { userId: user.id, passwordHash: input.passwordHash, algorithm: input.algorithm, mustChangePassword: true } });
          const membership = await tx.schoolMembership.create({
            data: { schoolId, userId: user.id, status: "ACTIVE", roles: { create: input.roles.map((role) => ({ role })) } },
            include,
          });
          return toRecord(membership);
        });
      } catch (error) { return translate(error); }
    },

    async setRoles(schoolId, membershipId, roles: StaffRole[], keepAnotherOwner) {
      return db.$transaction(async (tx) => {
        if (keepAnotherOwner) await lockActiveMemberships(tx, schoolId);
        const current = await tx.schoolMembership.findFirst({ where: { id: membershipId, schoolId }, select: { id: true } });
        if (!current) return null;
        if (keepAnotherOwner && (await otherActiveOwners(tx, schoolId, membershipId)) === 0) throw new RepositoryConflict("overlap");
        await tx.schoolMembershipRole.deleteMany({ where: { membershipId, role: { notIn: roles } } });
        await tx.schoolMembershipRole.createMany({ data: roles.map((role) => ({ membershipId, role })), skipDuplicates: true });
        await tx.schoolMembership.updateMany({ where: { id: membershipId, schoolId }, data: { updatedAt: new Date() } });
        const row = await tx.schoolMembership.findFirst({ where: { id: membershipId, schoolId }, include });
        return row ? toRecord(row) : null;
      });
    },

    async setStatus(schoolId, membershipId, status, at, keepAnotherOwner) {
      return db.$transaction(async (tx) => {
        if (keepAnotherOwner) await lockActiveMemberships(tx, schoolId);
        const current = await tx.schoolMembership.findFirst({ where: { id: membershipId, schoolId }, select: { id: true } });
        if (!current) return null;
        if (keepAnotherOwner && (await otherActiveOwners(tx, schoolId, membershipId)) === 0) throw new RepositoryConflict("overlap");
        // The database requires ended_at to be set exactly when the status is ENDED.
        await tx.schoolMembership.updateMany({ where: { id: membershipId, schoolId }, data: { status, endedAt: status === "ENDED" ? at : null } });
        const row = await tx.schoolMembership.findFirst({ where: { id: membershipId, schoolId }, include });
        return row ? toRecord(row) : null;
      });
    },

    countActiveOwners: (schoolId, exceptMembershipId) =>
      db.schoolMembership.count({
        where: { schoolId, id: { not: exceptMembershipId }, status: "ACTIVE", user: { status: "ACTIVE" }, roles: { some: { role: "OWNER" } } },
      }),

    async countOtherSchoolMemberships(schoolId, membershipId) {
      const row = await db.schoolMembership.findFirst({ where: { id: membershipId, schoolId }, select: { userId: true } });
      if (!row) return 0;
      return db.schoolMembership.count({ where: { userId: row.userId, schoolId: { not: schoolId } } });
    },

    async setTemporaryPassword(schoolId, membershipId, hash, algorithm, at) {
      return db.$transaction(async (tx) => {
        const row = await tx.schoolMembership.findFirst({ where: { id: membershipId, schoolId }, select: { userId: true } });
        if (!row) return null;
        const changed = await tx.userCredential.updateMany({
          where: { userId: row.userId },
          data: { passwordHash: hash, algorithm, passwordChangedAt: at, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
        });
        if (changed.count !== 1) return null;
        const revoked = await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: at, revokedReason: "admin_revoked" } });
        return revoked.count;
      });
    },

    async appendAudit(event: AuditEventInput) {
      await db.auditEvent.create({
        data: {
          schoolId: event.schoolId, actorUserId: event.actorUserId, action: event.action,
          entityType: event.entityType, entityId: event.entityId, metadata: event.metadata as object,
        },
      });
    },
  };
}
