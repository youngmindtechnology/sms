import type { PrismaClient } from "@ymt/database";
import type { AuditEventInput } from "../auth/ports.js";
import {
  SubjectConflict,
  type AssignmentRecord, type AssignmentStatus, type AuditDraft, type SubjectPatch, type SubjectRecord, type SubjectRepository,
} from "../subjects/ports.js";

const toSubject = (s: { id: string; classId: string; name: string; code: string | null; isActive: boolean }): SubjectRecord => ({
  id: s.id, classId: s.classId, name: s.name, code: s.code, isActive: s.isActive,
});

type AssignmentRow = {
  id: string; subjectId: string; academicYearId: string; status: string; endedAt: Date | null; createdAt: Date;
  academicYear: { name: string };
  membership: { id: string; user: { fullName: string } };
};

/** Only a name is read from the user. No e-mail, no user id, never anything from the credential. */
const assignmentInclude = {
  academicYear: { select: { name: true } },
  membership: { select: { id: true, user: { select: { fullName: true } } } },
} as const;

const toAssignment = (a: AssignmentRow): AssignmentRecord => ({
  id: a.id, subjectId: a.subjectId, academicYearId: a.academicYearId, academicYearName: a.academicYear.name,
  teacherMembershipId: a.membership.id, teacherName: a.membership.user.fullName,
  status: a.status as AssignmentStatus, endedAt: a.endedAt ? a.endedAt.toISOString() : null, createdAt: a.createdAt.toISOString(),
});

const isCode = (error: unknown, code: string) => (error as { code?: unknown } | null)?.code === code;

/**
 * A unique-index violation (P2002) on subjects is a name or a code clash. Prisma cannot name
 * the SQL-only case-insensitive name index, so anything that does not mention the code is the name.
 * Nothing from the original error is kept.
 */
function translateSubject(error: unknown): never {
  if (isCode(error, "P2002")) {
    const text = JSON.stringify((error as { meta?: unknown }).meta ?? {}) + String((error as { message?: unknown }).message ?? "");
    throw new SubjectConflict(/code/i.test(text) && !/lower_name/i.test(text) ? "code" : "name");
  }
  if (isCode(error, "P2003")) throw new SubjectConflict("state");
  throw error;
}

function translateAssignment(error: unknown): never {
  if (isCode(error, "P2002")) throw new SubjectConflict("assignment");
  if (isCode(error, "P2003")) throw new SubjectConflict("state");
  throw error;
}

/**
 * PostgreSQL-backed subjects and teaching assignments. Every query includes the school id. Nothing is deleted.
 *
 * The assignment writes run in ONE transaction. They lock the rows they depend on (the subject, the year and the
 * teacher's membership with FOR SHARE; the assignment being replaced with FOR UPDATE) and then re-check them, so
 * a subject deactivated, a year closed or a teacher suspended by another request a moment earlier cannot slip
 * through. If anything fails the whole transaction (including the audit event) is rolled back.
 */
export function createPrismaSubjectRepository(db: PrismaClient): SubjectRepository {
  type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

  /** Locks and verifies subject, year and teacher; returns the teacher's user id. Throws SubjectConflict. */
  async function lockAndCheck(tx: Tx, schoolId: string, subjectId: string, yearId: string, membershipId: string): Promise<string> {
    const subject = await tx.$queryRaw<Array<{ is_active: boolean }>>`
      SELECT is_active FROM subjects WHERE id = ${subjectId}::uuid AND school_id = ${schoolId}::uuid FOR SHARE`;
    const year = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status::text AS status FROM academic_years WHERE id = ${yearId}::uuid AND school_id = ${schoolId}::uuid FOR SHARE`;
    if (!subject[0]?.is_active || !year[0] || year[0].status === "CLOSED") throw new SubjectConflict("state");

    const member = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT m.user_id FROM school_memberships m
        JOIN users u ON u.id = m.user_id
       WHERE m.id = ${membershipId}::uuid AND m.school_id = ${schoolId}::uuid
         AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
         AND EXISTS (SELECT 1 FROM school_membership_roles r WHERE r.membership_id = m.id AND r.role = 'TEACHER')
       FOR SHARE OF m`;
    if (!member[0]) throw new SubjectConflict("teacher");
    return member[0].user_id;
  }

  async function auditIn(tx: Tx, schoolId: string, draft: AuditDraft, entityId: string) {
    await tx.auditEvent.create({
      data: {
        schoolId, actorUserId: draft.actorUserId, action: draft.action, entityType: "teaching_assignment",
        entityId, metadata: draft.metadata as object,
      },
    });
  }

  const reread = async (tx: Tx, schoolId: string, id: string) => {
    const row = await tx.teachingAssignment.findFirst({ where: { id, schoolId }, include: assignmentInclude });
    if (!row) throw new SubjectConflict("state");
    return toAssignment(row);
  };

  return {
    async findClass(schoolId, classId) {
      const c = await db.class.findFirst({ where: { id: classId, schoolId }, select: { id: true, name: true, isActive: true } });
      return c ?? null;
    },

    async findYear(schoolId, yearId) {
      const y = await db.academicYear.findFirst({ where: { id: yearId, schoolId }, select: { id: true, name: true, status: true } });
      return y ? { id: y.id, name: y.name, status: y.status } : null;
    },

    async listSubjects(schoolId, classId) {
      const rows = await db.subject.findMany({ where: { schoolId, classId }, orderBy: [{ name: "asc" }, { id: "asc" }] });
      return rows.map(toSubject);
    },

    async findSubject(schoolId, subjectId) {
      const row = await db.subject.findFirst({ where: { id: subjectId, schoolId } });
      return row ? toSubject(row) : null;
    },

    async createSubject(schoolId, input) {
      try {
        return toSubject(await db.subject.create({ data: { schoolId, classId: input.classId, name: input.name, code: input.code } }));
      } catch (error) { return translateSubject(error); }
    },

    async updateSubject(schoolId, subjectId, patch: SubjectPatch) {
      try {
        const result = await db.subject.updateMany({
          where: { id: subjectId, schoolId },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.code !== undefined ? { code: patch.code } : {}),
            ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          },
        });
        if (result.count === 0) return null;
        const row = await db.subject.findFirst({ where: { id: subjectId, schoolId } });
        return row ? toSubject(row) : null;
      } catch (error) { return translateSubject(error); }
    },

    async appendAudit(event: AuditEventInput) {
      await db.auditEvent.create({
        data: {
          schoolId: event.schoolId, actorUserId: event.actorUserId, action: event.action,
          entityType: event.entityType, entityId: event.entityId, metadata: event.metadata as object,
        },
      });
    },

    async listActiveAssignmentsForClass(schoolId, classId, academicYearId) {
      const rows = await db.teachingAssignment.findMany({
        where: { schoolId, academicYearId, status: "ACTIVE", subject: { classId } },
        include: assignmentInclude,
        orderBy: [{ membership: { user: { fullName: "asc" } } }, { id: "asc" }],
      });
      return rows.map(toAssignment);
    },

    async listAssignments(schoolId, subjectId, opts) {
      const rows = await db.teachingAssignment.findMany({
        where: { schoolId, subjectId, ...(opts.academicYearId ? { academicYearId: opts.academicYearId } : {}), ...(opts.includeEnded ? {} : { status: "ACTIVE" }) },
        include: assignmentInclude,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      });
      return rows.map(toAssignment);
    },

    async findAssignment(schoolId, assignmentId) {
      const row = await db.teachingAssignment.findFirst({ where: { id: assignmentId, schoolId }, include: assignmentInclude });
      return row ? toAssignment(row) : null;
    },

    async findTeacher(schoolId, membershipId) {
      const m = await db.schoolMembership.findFirst({
        where: { id: membershipId, schoolId },
        select: { id: true, status: true, user: { select: { fullName: true, status: true } }, roles: { select: { role: true } } },
      });
      if (!m) return null;
      return {
        membershipId: m.id, fullName: m.user.fullName,
        eligible: m.status === "ACTIVE" && m.user.status === "ACTIVE" && m.roles.some((r) => r.role === "TEACHER"),
      };
    },

    async listEligibleTeachers(schoolId) {
      const rows = await db.schoolMembership.findMany({
        where: { schoolId, status: "ACTIVE", user: { status: "ACTIVE" }, roles: { some: { role: "TEACHER" } } },
        select: { id: true, user: { select: { fullName: true } } },
        orderBy: [{ user: { fullName: "asc" } }, { id: "asc" }],
      });
      return rows.map((m) => ({ membershipId: m.id, fullName: m.user.fullName }));
    },

    async createAssignment(schoolId, input, draft) {
      try {
        return await db.$transaction(async (tx) => {
          const userId = await lockAndCheck(tx, schoolId, input.subjectId, input.academicYearId, input.teacherMembershipId);
          const created = await tx.teachingAssignment.create({ data: { schoolId, subjectId: input.subjectId, academicYearId: input.academicYearId, userId }, select: { id: true } });
          await auditIn(tx, schoolId, draft, created.id);
          return reread(tx, schoolId, created.id);
        });
      } catch (error) { return translateAssignment(error); }
    },

    async replaceAssignment(schoolId, assignmentId, teacherMembershipId, at, draft) {
      try {
        return await db.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ subject_id: string; academic_year_id: string; status: string }>>`
            SELECT subject_id, academic_year_id, status::text AS status FROM teaching_assignments
             WHERE id = ${assignmentId}::uuid AND school_id = ${schoolId}::uuid FOR UPDATE`;
          const old = locked[0];
          if (!old) return null;
          if (old.status !== "ACTIVE") throw new SubjectConflict("stale");

          const userId = await lockAndCheck(tx, schoolId, old.subject_id, old.academic_year_id, teacherMembershipId);
          await tx.teachingAssignment.update({ where: { id: assignmentId }, data: { status: "ENDED", endedAt: at } });
          const created = await tx.teachingAssignment.create({
            data: { schoolId, subjectId: old.subject_id, academicYearId: old.academic_year_id, userId }, select: { id: true },
          });
          await auditIn(tx, schoolId, draft, created.id);
          return { ended: await reread(tx, schoolId, assignmentId), created: await reread(tx, schoolId, created.id) };
        });
      } catch (error) { return translateAssignment(error); }
    },

    async endAssignment(schoolId, assignmentId, at, draft) {
      return db.$transaction(async (tx) => {
        const changed = await tx.teachingAssignment.updateMany({ where: { id: assignmentId, schoolId, status: "ACTIVE" }, data: { status: "ENDED", endedAt: at } });
        if (changed.count === 0) {
          const exists = await tx.teachingAssignment.count({ where: { id: assignmentId, schoolId } });
          if (exists === 0) return null;
          throw new SubjectConflict("stale");
        }
        await auditIn(tx, schoolId, draft, assignmentId);
        return reread(tx, schoolId, assignmentId);
      });
    },
  };
}
