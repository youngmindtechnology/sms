import type { PrismaClient } from "@ymt/database";
import type { AuditEventInput } from "../auth/ports.js";
import {
  RepositoryConflict,
  type AcademicRepository, type NewTerm, type NewYear, type PeriodStatus, type TermPatch, type TermRecord, type YearPatch, type YearRecord,
} from "../academic/ports.js";

const toDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const toText = (value: Date) => value.toISOString().slice(0, 10);

const toYear = (y: { id: string; name: string; startDate: Date; endDate: Date; status: string }): YearRecord => ({
  id: y.id, name: y.name, startDate: toText(y.startDate), endDate: toText(y.endDate), status: y.status as PeriodStatus,
});
const toTerm = (t: { id: string; academicYearId: string; name: string; sequence: number; startDate: Date; endDate: Date; status: string }): TermRecord => ({
  id: t.id, academicYearId: t.academicYearId, name: t.name, sequence: t.sequence,
  startDate: toText(t.startDate), endDate: toText(t.endDate), status: t.status as PeriodStatus,
});

/**
 * Turns a database refusal into RepositoryConflict. A unique-index violation is P2002; an
 * EXCLUDE (overlap) violation has SQLSTATE 23P01. Nothing from the original error is kept,
 * because database messages can contain submitted values.
 */
function translate(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2002") throw new RepositoryConflict("duplicate");
  const text = error instanceof Error ? error.message : "";
  if (text.includes("23P01") || /exclusion constraint/i.test(text)) throw new RepositoryConflict("overlap");
  throw error;
}

/**
 * PostgreSQL-backed academic calendar. Every query includes the school id, so a guessed
 * identifier from another school simply finds nothing.
 */
export function createPrismaAcademicRepository(db: PrismaClient): AcademicRepository {
  return {
    async listYears(schoolId) {
      const rows = await db.academicYear.findMany({ where: { schoolId }, orderBy: { startDate: "desc" } });
      return rows.map(toYear);
    },

    async findYear(schoolId, yearId) {
      const row = await db.academicYear.findFirst({ where: { id: yearId, schoolId } });
      return row ? toYear(row) : null;
    },

    async createYear(schoolId, input: NewYear) {
      try {
        const row = await db.academicYear.create({
          data: { schoolId, name: input.name, startDate: toDate(input.startDate), endDate: toDate(input.endDate) },
        });
        return toYear(row);
      } catch (error) { return translate(error); }
    },

    async updateYear(schoolId, yearId, patch: YearPatch) {
      try {
        const result = await db.academicYear.updateMany({
          where: { id: yearId, schoolId },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.startDate !== undefined ? { startDate: toDate(patch.startDate) } : {}),
            ...(patch.endDate !== undefined ? { endDate: toDate(patch.endDate) } : {}),
          },
        });
        if (result.count === 0) return null;
        const row = await db.academicYear.findFirst({ where: { id: yearId, schoolId } });
        return row ? toYear(row) : null;
      } catch (error) { return translate(error); }
    },

    async activateYear(schoolId, yearId) {
      try {
        return await db.$transaction(async (tx) => {
          const target = await tx.academicYear.findFirst({ where: { id: yearId, schoolId } });
          if (!target) return null;
          const previous = await tx.academicYear.findFirst({ where: { schoolId, status: "ACTIVE", NOT: { id: yearId } } });
          if (previous) {
            await tx.term.updateMany({ where: { schoolId, academicYearId: previous.id, status: "ACTIVE" }, data: { status: "CLOSED" } });
            await tx.academicYear.updateMany({ where: { id: previous.id, schoolId }, data: { status: "CLOSED" } });
          }
          await tx.academicYear.updateMany({ where: { id: yearId, schoolId }, data: { status: "ACTIVE" } });
          const year = await tx.academicYear.findFirstOrThrow({ where: { id: yearId, schoolId } });
          return { year: toYear(year), closedYearId: previous?.id ?? null };
        });
      } catch (error) { return translate(error); }
    },

    async closeYear(schoolId, yearId) {
      return db.$transaction(async (tx) => {
        const target = await tx.academicYear.findFirst({ where: { id: yearId, schoolId } });
        if (!target) return null;
        await tx.term.updateMany({ where: { schoolId, academicYearId: yearId, status: "ACTIVE" }, data: { status: "CLOSED" } });
        await tx.academicYear.updateMany({ where: { id: yearId, schoolId }, data: { status: "CLOSED" } });
        const year = await tx.academicYear.findFirstOrThrow({ where: { id: yearId, schoolId } });
        return toYear(year);
      });
    },

    async listTerms(schoolId, yearId) {
      const rows = await db.term.findMany({ where: { schoolId, academicYearId: yearId }, orderBy: { sequence: "asc" } });
      return rows.map(toTerm);
    },

    async findTerm(schoolId, yearId, termId) {
      const row = await db.term.findFirst({ where: { id: termId, academicYearId: yearId, schoolId } });
      return row ? toTerm(row) : null;
    },

    async createTerm(schoolId, yearId, input: NewTerm) {
      try {
        const year = await db.academicYear.findFirst({ where: { id: yearId, schoolId } });
        if (!year) return null;
        const row = await db.term.create({
          data: {
            schoolId, academicYearId: yearId, name: input.name, sequence: input.sequence,
            startDate: toDate(input.startDate), endDate: toDate(input.endDate),
          },
        });
        return toTerm(row);
      } catch (error) { return translate(error); }
    },

    async updateTerm(schoolId, yearId, termId, patch: TermPatch) {
      try {
        const result = await db.term.updateMany({
          where: { id: termId, academicYearId: yearId, schoolId },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.sequence !== undefined ? { sequence: patch.sequence } : {}),
            ...(patch.startDate !== undefined ? { startDate: toDate(patch.startDate) } : {}),
            ...(patch.endDate !== undefined ? { endDate: toDate(patch.endDate) } : {}),
          },
        });
        if (result.count === 0) return null;
        const row = await db.term.findFirst({ where: { id: termId, academicYearId: yearId, schoolId } });
        return row ? toTerm(row) : null;
      } catch (error) { return translate(error); }
    },

    async activateTerm(schoolId, yearId, termId) {
      try {
        return await db.$transaction(async (tx) => {
          const target = await tx.term.findFirst({ where: { id: termId, academicYearId: yearId, schoolId } });
          if (!target) return null;
          const previous = await tx.term.findFirst({ where: { schoolId, status: "ACTIVE", NOT: { id: termId } } });
          if (previous) await tx.term.updateMany({ where: { id: previous.id, schoolId }, data: { status: "CLOSED" } });
          await tx.term.updateMany({ where: { id: termId, schoolId }, data: { status: "ACTIVE" } });
          const term = await tx.term.findFirstOrThrow({ where: { id: termId, schoolId } });
          return { term: toTerm(term), closedTermId: previous?.id ?? null };
        });
      } catch (error) { return translate(error); }
    },

    async closeTerm(schoolId, yearId, termId) {
      const result = await db.term.updateMany({ where: { id: termId, academicYearId: yearId, schoolId }, data: { status: "CLOSED" } });
      if (result.count === 0) return null;
      const row = await db.term.findFirst({ where: { id: termId, schoolId } });
      return row ? toTerm(row) : null;
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
