import type { PrismaClient } from "@ymt/database";
import { RepositoryConflict } from "../academic/ports.js";
import type { AuditEventInput } from "../auth/ports.js";
import type {
  EnrollmentRecord, EnrollmentStatus, GuardianRecord, GuardianRelationship, LinkRecord, NewEnrollment, RosterEntry, StudentListItem,
  StudentQuery, StudentRecord, StudentRepository, StudentStatus, StudentSummary,
} from "../students/ports.js";

const toDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const toText = (value: Date) => value.toISOString().slice(0, 10);

/**
 * Turns a database refusal into RepositoryConflict. A unique-index or primary-key violation is
 * P2002; an EXCLUDE (overlap) violation has SQLSTATE 23P01. Nothing from the original error is
 * kept, because database messages can contain submitted values.
 */
function translate(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2002") throw new RepositoryConflict("duplicate");
  const text = error instanceof Error ? error.message : "";
  if (text.includes("23P01") || /exclusion constraint/i.test(text)) throw new RepositoryConflict("overlap");
  throw error;
}

type StudentRow = {
  id: string; admissionNumber: string; firstName: string; middleName: string | null; lastName: string;
  dateOfBirth: Date | null; admittedOn: Date | null; status: string;
};
const toStudent = (s: StudentRow): StudentRecord => ({
  id: s.id, admissionNumber: s.admissionNumber, firstName: s.firstName, middleName: s.middleName, lastName: s.lastName,
  dateOfBirth: s.dateOfBirth ? toText(s.dateOfBirth) : null, admittedOn: s.admittedOn ? toText(s.admittedOn) : null, status: s.status as StudentStatus,
});
const toSummary = (s: StudentRow): StudentSummary => ({
  id: s.id, admissionNumber: s.admissionNumber, firstName: s.firstName, middleName: s.middleName, lastName: s.lastName, status: s.status as StudentStatus,
});
const toGuardian = (g: { id: string; fullName: string; phone: string | null; email: string | null }): GuardianRecord => ({
  id: g.id, fullName: g.fullName, phone: g.phone, email: g.email,
});
const toLink = (l: { studentId: string; guardianId: string; relationship: string; isPrimaryContact: boolean }): LinkRecord => ({
  studentId: l.studentId, guardianId: l.guardianId, relationship: l.relationship as GuardianRelationship, isPrimaryContact: l.isPrimaryContact,
});
type EnrollmentRow = {
  id: string; studentId: string; classId: string; academicYearId: string; status: string; startDate: Date; endDate: Date | null;
  class: { name: string }; academicYear: { name: string };
};
const toEnrollment = (e: EnrollmentRow): EnrollmentRecord => ({
  id: e.id, studentId: e.studentId, classId: e.classId, className: e.class.name, academicYearId: e.academicYearId, academicYearName: e.academicYear.name,
  status: e.status as EnrollmentStatus, startDate: toText(e.startDate), endDate: e.endDate ? toText(e.endDate) : null,
});
const withNames = { class: { select: { name: true } }, academicYear: { select: { name: true } } } as const;

/**
 * PostgreSQL-backed students, guardians, links and enrollments. Every query includes the school
 * id, so an identifier guessed from another school simply finds nothing. Multi-row writes run in
 * one transaction. Nothing is ever deleted except a student-guardian link.
 */
export function createPrismaStudentRepository(db: PrismaClient): StudentRepository {
  return {
    // ----- students -----
    async listStudents(schoolId, query: StudentQuery) {
      const nameMatch = query.nameTerms.map((term) => ({
        OR: [
          { firstName: { contains: term, mode: "insensitive" as const } },
          { middleName: { contains: term, mode: "insensitive" as const } },
          { lastName: { contains: term, mode: "insensitive" as const } },
        ],
      }));
      const searchClauses = [
        ...(nameMatch.length > 0 ? [{ AND: nameMatch }] : []),
        ...(query.admissionText ? [{ admissionNumber: { contains: query.admissionText } }] : []),
      ];
      const where = {
        schoolId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.classId ? { enrollments: { some: { schoolId, classId: query.classId, status: "ENROLLED" as const } } } : {}),
        ...(searchClauses.length > 0 ? { OR: searchClauses } : {}),
      };
      const [rows, total] = await Promise.all([
        db.student.findMany({
          where,
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          include: { enrollments: { where: { schoolId, status: "ENROLLED" }, orderBy: { startDate: "desc" }, take: 1, include: withNames } },
        }),
        db.student.count({ where }),
      ]);
      const items: StudentListItem[] = rows.map((row) => {
        const open = row.enrollments[0];
        return {
          ...toSummary(row),
          current: open ? { enrollmentId: open.id, classId: open.classId, className: open.class.name, academicYearId: open.academicYearId, academicYearName: open.academicYear.name } : null,
        };
      });
      return { items, total };
    },

    countStudents: (schoolId) => db.student.count({ where: { schoolId } }),

    async findStudent(schoolId, studentId) {
      const row = await db.student.findFirst({ where: { id: studentId, schoolId } });
      return row ? toStudent(row) : null;
    },

    async createStudent(schoolId, input) {
      try {
        const row = await db.student.create({
          data: {
            schoolId, admissionNumber: input.admissionNumber, firstName: input.firstName, middleName: input.middleName, lastName: input.lastName,
            dateOfBirth: input.dateOfBirth ? toDate(input.dateOfBirth) : null, admittedOn: input.admittedOn ? toDate(input.admittedOn) : null,
          },
        });
        return toStudent(row);
      } catch (error) { return translate(error); }
    },

    async updateStudent(schoolId, studentId, patch) {
      try {
        const result = await db.student.updateMany({
          where: { id: studentId, schoolId },
          data: {
            ...(patch.admissionNumber !== undefined ? { admissionNumber: patch.admissionNumber } : {}),
            ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
            ...(patch.middleName !== undefined ? { middleName: patch.middleName } : {}),
            ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
            ...(patch.dateOfBirth !== undefined ? { dateOfBirth: patch.dateOfBirth ? toDate(patch.dateOfBirth) : null } : {}),
            ...(patch.admittedOn !== undefined ? { admittedOn: patch.admittedOn ? toDate(patch.admittedOn) : null } : {}),
          },
        });
        if (result.count === 0) return null;
        const row = await db.student.findFirst({ where: { id: studentId, schoolId } });
        return row ? toStudent(row) : null;
      } catch (error) { return translate(error); }
    },

    async setStudentStatus(schoolId, studentId, status, close) {
      return db.$transaction(async (tx) => {
        const changed = await tx.student.updateMany({ where: { id: studentId, schoolId }, data: { status } });
        if (changed.count === 0) return null;
        const closedEnrollmentIds: string[] = [];
        if (close) {
          const open = await tx.enrollment.findMany({ where: { schoolId, studentId, status: "ENROLLED" }, select: { id: true, endDate: true } });
          for (const e of open) {
            const keep = e.endDate !== null && toText(e.endDate) < close.effectiveDate;
            await tx.enrollment.updateMany({
              where: { id: e.id, schoolId },
              data: { status: close.status, endDate: keep ? e.endDate : toDate(close.effectiveDate) },
            });
            closedEnrollmentIds.push(e.id);
          }
        }
        const row = await tx.student.findFirst({ where: { id: studentId, schoolId } });
        return row ? { student: toStudent(row), closedEnrollmentIds } : null;
      });
    },

    // ----- guardians and links -----
    async findGuardian(schoolId, guardianId) {
      const row = await db.guardian.findFirst({ where: { id: guardianId, schoolId } });
      return row ? toGuardian(row) : null;
    },

    async searchGuardians(schoolId, term, limit) {
      const rows = await db.guardian.findMany({
        where: { schoolId, OR: [{ fullName: { contains: term, mode: "insensitive" } }, { phone: { contains: term } }] },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: limit,
      });
      return rows.map(toGuardian);
    },

    async updateGuardian(schoolId, guardianId, patch) {
      const result = await db.guardian.updateMany({
        where: { id: guardianId, schoolId },
        data: {
          ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
          ...(patch.email !== undefined ? { email: patch.email } : {}),
        },
      });
      if (result.count === 0) return null;
      const row = await db.guardian.findFirst({ where: { id: guardianId, schoolId } });
      return row ? toGuardian(row) : null;
    },

    async listGuardianLinks(schoolId, studentId) {
      const rows = await db.studentGuardian.findMany({ where: { schoolId, studentId }, include: { guardian: true }, orderBy: [{ isPrimaryContact: "desc" }, { createdAt: "asc" }] });
      return rows.map((r) => ({ ...toGuardian(r.guardian), relationship: r.relationship as GuardianRelationship, isPrimaryContact: r.isPrimaryContact }));
    },

    async listLinkedStudents(schoolId, guardianId) {
      const rows = await db.studentGuardian.findMany({ where: { schoolId, guardianId }, include: { student: true }, orderBy: { createdAt: "asc" } });
      return rows.map((r) => ({ ...toSummary(r.student), relationship: r.relationship as GuardianRelationship, isPrimaryContact: r.isPrimaryContact }));
    },

    async findLink(schoolId, studentId, guardianId) {
      const row = await db.studentGuardian.findFirst({ where: { schoolId, studentId, guardianId } });
      return row ? toLink(row) : null;
    },

    async linkGuardian(schoolId, studentId, guardianId, relationship, isPrimaryContact) {
      try {
        return await db.$transaction(async (tx) => {
          const [student, guardian] = await Promise.all([
            tx.student.findFirst({ where: { id: studentId, schoolId }, select: { id: true } }),
            tx.guardian.findFirst({ where: { id: guardianId, schoolId }, select: { id: true } }),
          ]);
          if (!student || !guardian) return null;
          // The database allows one primary guardian per student, so the old one steps down first.
          if (isPrimaryContact) await tx.studentGuardian.updateMany({ where: { schoolId, studentId, isPrimaryContact: true }, data: { isPrimaryContact: false } });
          return toLink(await tx.studentGuardian.create({ data: { schoolId, studentId, guardianId, relationship, isPrimaryContact } }));
        });
      } catch (error) { return translate(error); }
    },

    async createGuardianAndLink(schoolId, studentId, input, relationship, isPrimaryContact) {
      try {
        return await db.$transaction(async (tx) => {
          const student = await tx.student.findFirst({ where: { id: studentId, schoolId }, select: { id: true } });
          if (!student) return null;
          const guardian = await tx.guardian.create({ data: { schoolId, fullName: input.fullName, phone: input.phone, email: input.email } });
          if (isPrimaryContact) await tx.studentGuardian.updateMany({ where: { schoolId, studentId, isPrimaryContact: true }, data: { isPrimaryContact: false } });
          const link = await tx.studentGuardian.create({ data: { schoolId, studentId, guardianId: guardian.id, relationship, isPrimaryContact } });
          return { guardian: toGuardian(guardian), link: toLink(link) };
        });
      } catch (error) { return translate(error); }
    },

    async updateLink(schoolId, studentId, guardianId, patch) {
      try {
        return await db.$transaction(async (tx) => {
          const current = await tx.studentGuardian.findFirst({ where: { schoolId, studentId, guardianId } });
          if (!current) return null;
          if (patch.isPrimaryContact) {
            await tx.studentGuardian.updateMany({ where: { schoolId, studentId, isPrimaryContact: true, NOT: { guardianId } }, data: { isPrimaryContact: false } });
          }
          await tx.studentGuardian.updateMany({
            where: { schoolId, studentId, guardianId },
            data: {
              ...(patch.relationship !== undefined ? { relationship: patch.relationship } : {}),
              ...(patch.isPrimaryContact !== undefined ? { isPrimaryContact: patch.isPrimaryContact } : {}),
            },
          });
          const row = await tx.studentGuardian.findFirst({ where: { schoolId, studentId, guardianId } });
          return row ? toLink(row) : null;
        });
      } catch (error) { return translate(error); }
    },

    async unlinkGuardian(schoolId, studentId, guardianId) {
      const result = await db.studentGuardian.deleteMany({ where: { schoolId, studentId, guardianId } });
      return result.count > 0;
    },

    // ----- enrollments -----
    async findClassRef(schoolId, classId) {
      const row = await db.class.findFirst({ where: { id: classId, schoolId }, select: { id: true, name: true, isActive: true } });
      return row ? { id: row.id, name: row.name, isActive: row.isActive } : null;
    },

    async findYearRef(schoolId, yearId) {
      const row = await db.academicYear.findFirst({ where: { id: yearId, schoolId } });
      return row ? { id: row.id, name: row.name, status: row.status, startDate: toText(row.startDate), endDate: toText(row.endDate) } : null;
    },

    async listEnrollments(schoolId, studentId) {
      const rows = await db.enrollment.findMany({ where: { schoolId, studentId }, include: withNames, orderBy: [{ startDate: "desc" }, { id: "asc" }] });
      return rows.map(toEnrollment);
    },

    async createEnrollment(schoolId, input: NewEnrollment) {
      try {
        const row = await db.enrollment.create({
          data: {
            schoolId, studentId: input.studentId, classId: input.classId, academicYearId: input.academicYearId,
            startDate: toDate(input.startDate), endDate: toDate(input.endDate),
          },
          include: withNames,
        });
        return toEnrollment(row);
      } catch (error) { return translate(error); }
    },

    async transferEnrollment(schoolId, fromEnrollmentId, oldEndDate, next) {
      try {
        return await db.$transaction(async (tx) => {
          const old = await tx.enrollment.findFirst({ where: { id: fromEnrollmentId, schoolId, studentId: next.studentId } });
          if (!old) return null;
          // The old row is kept as history: only its status and end date change. The update only
          // succeeds while the row is STILL open. If a concurrent request already ended it, nothing
          // is changed, no new enrollment is created (the throw rolls the transaction back), and
          // the caller gets a clean conflict.
          const ended = await tx.enrollment.updateMany({
            where: { id: fromEnrollmentId, schoolId, studentId: next.studentId, status: "ENROLLED" },
            data: { status: "CLASS_CHANGED", endDate: toDate(oldEndDate) },
          });
          if (ended.count !== 1) throw new RepositoryConflict("overlap");
          const created = await tx.enrollment.create({
            data: { schoolId, studentId: next.studentId, classId: next.classId, academicYearId: next.academicYearId, startDate: toDate(next.startDate), endDate: toDate(next.endDate) },
            include: withNames,
          });
          const endedRow = await tx.enrollment.findFirst({ where: { id: fromEnrollmentId, schoolId }, include: withNames });
          return endedRow ? { ended: toEnrollment(endedRow), created: toEnrollment(created) } : null;
        });
      } catch (error) { return translate(error); }
    },

    async listRoster(schoolId, classId, academicYearId, includeEnded): Promise<RosterEntry[]> {
      const rows = await db.enrollment.findMany({
        where: { schoolId, classId, academicYearId, ...(includeEnded ? {} : { status: "ENROLLED" as const }) },
        include: { student: true },
        orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }, { id: "asc" }],
      });
      return rows.map((r) => ({ enrollmentId: r.id, status: r.status as EnrollmentStatus, startDate: toText(r.startDate), endDate: r.endDate ? toText(r.endDate) : null, student: toSummary(r.student) }));
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
