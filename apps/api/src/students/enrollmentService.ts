import { RepositoryConflict } from "../academic/ports.js";
import { isCalendarDate } from "../academic/dates.js";
import { dayAfter, dayBefore, fail, makeAudit, ok, todayOf, type Actor, type Result } from "./common.js";
import type { ClassRef, EnrollmentRecord, RosterEntry, StudentRepository, YearRef } from "./ports.js";

export interface Roster { class: ClassRef; academicYear: YearRef; entries: RosterEntry[] }

/**
 * Enrollment rules (product decisions):
 *  - Only ACTIVE students can be enrolled.
 *  - Only ACTIVE classes can receive students; deactivating a class keeps its past enrollments.
 *  - New enrollments are allowed in PLANNED and ACTIVE academic years, never in a CLOSED one.
 *  - An enrollment runs from its start date to the end of the academic year (inclusive).
 *  - A student can't be in two classes at the same time. The database enforces this too.
 *  - A reactivated student has no current enrollment, so they are enrolled normally. Their old ended
 *    enrollment stays as history; the new one gets its own id and starts after the old one's last day.
 *  - A class change keeps the old enrollment as history: it ends the day before, with status
 *    CLASS_CHANGED, and a new enrollment starts on the effective date. Nothing is overwritten.
 */
export function createEnrollmentService(repo: StudentRepository, now: () => Date = () => new Date()) {
  async function guard<T>(work: () => Promise<Result<T>>, conflict: { field: string; message: string } = { field: "startDate", message: "This student already has an enrollment in that period." }): Promise<Result<T>> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RepositoryConflict) return fail("already_enrolled", { [conflict.field]: conflict.message });
      throw error;
    }
  }

  /** Looks up a class and year that the REQUEST names. Foreign and missing records look the same. */
  async function resolve(actor: Actor, classId: unknown, yearId: unknown, errors: Record<string, string>) {
    let cls: ClassRef | null = null;
    let year: YearRef | null = null;
    if (typeof classId === "string") cls = await repo.findClassRef(actor.schoolId, classId);
    if (!cls) errors.classId = "Choose a class from your school.";
    if (yearId !== undefined) {
      if (typeof yearId === "string") year = await repo.findYearRef(actor.schoolId, yearId);
      if (!year) errors.academicYearId = "Choose an academic year from your school.";
    }
    return { cls, year };
  }

  async function list(actor: Actor, studentId: string): Promise<Result<EnrollmentRecord[]>> {
    if (!(await repo.findStudent(actor.schoolId, studentId))) return fail("not_found");
    return ok(await repo.listEnrollments(actor.schoolId, studentId));
  }

  function enroll(actor: Actor, studentId: string, input: { classId?: unknown; academicYearId?: unknown; startDate?: unknown }): Promise<Result<EnrollmentRecord>> {
    return guard(async () => {
      const student = await repo.findStudent(actor.schoolId, studentId);
      if (!student) return fail("not_found");
      if (student.status !== "ACTIVE") return fail("student_not_active", { studentId: "Only active students can be enrolled." });

      const errors: Record<string, string> = {};
      const { cls, year } = await resolve(actor, input.classId, input.academicYearId ?? null, errors);
      if (input.academicYearId === undefined) errors.academicYearId = "Choose an academic year.";
      if (input.startDate !== undefined && !isCalendarDate(input.startDate)) errors.startDate = "Enter a valid start date.";
      if (Object.keys(errors).length || !cls || !year) return fail("validation_error", errors);

      if (!cls.isActive) return fail("class_inactive", { classId: "This class is inactive. Choose an active class." });
      if (year.status === "CLOSED") return fail("year_closed", { academicYearId: "This academic year is closed." });

      const today = todayOf(now);
      let start = typeof input.startDate === "string" ? input.startDate : today < year.startDate ? year.startDate : today;
      if (start < year.startDate || start > year.endDate) {
        return fail("validation_error", { startDate: `The start date must be within the academic year (${year.startDate} to ${year.endDate}).` });
      }
      start = start.slice(0, 10);

      // Only a CURRENT enrollment (ENROLLED) means "use Change class". Ended rows (withdrawn, class changed,
      // completed) are history: they stay exactly as they are, but the database still forbids two enrollments
      // that share a day, so a new one must start after the last day of any ended row it would touch.
      const existing = await repo.listEnrollments(actor.schoolId, studentId);
      const clashes = (from: string) => existing.filter((e) => e.startDate <= year.endDate && (e.endDate === null || e.endDate >= from));
      if (clashes(start).some((e) => e.status === "ENROLLED")) {
        return fail("already_enrolled", { startDate: "This student is already in a class. Use \"Change class\" instead." });
      }
      const ended = clashes(start);
      if (ended.length) {
        const lastDay = ended.reduce((latest, e) => (e.endDate !== null && e.endDate > latest ? e.endDate : latest), "");
        const earliest = dayAfter(lastDay);
        if (input.startDate !== undefined || earliest > year.endDate || clashes(earliest).length) {
          return fail("validation_error", {
            startDate: earliest <= year.endDate && !clashes(earliest).length
              ? `This student's earlier enrollment ran until ${lastDay}. Choose a start date from ${earliest}.`
              : "This student's earlier enrollments cover that period of the academic year, so there is no free day to start from.",
          });
        }
        start = earliest;
      }

      const created = await repo.createEnrollment(actor.schoolId, { studentId, classId: cls.id, academicYearId: year.id, startDate: start, endDate: year.endDate });
      await makeAudit(repo, actor)("enrollment.created", "enrollment", created.id, { studentId, classId: cls.id, academicYearId: year.id });
      return ok(created);
    });
  }

  /** Moves a student to another class in the same academic year, keeping the earlier enrollment as history. */
  function transfer(actor: Actor, studentId: string, input: { classId?: unknown; effectiveDate?: unknown }): Promise<Result<{ ended: EnrollmentRecord; created: EnrollmentRecord }>> {
    return guard(async () => {
      const student = await repo.findStudent(actor.schoolId, studentId);
      if (!student) return fail("not_found");
      if (student.status !== "ACTIVE") return fail("student_not_active", { studentId: "Only active students can change class." });

      const errors: Record<string, string> = {};
      const { cls } = await resolve(actor, input.classId, undefined, errors);
      if (input.effectiveDate !== undefined && !isCalendarDate(input.effectiveDate)) errors.effectiveDate = "Enter a valid date.";
      if (Object.keys(errors).length || !cls) return fail("validation_error", errors);

      const current = (await repo.listEnrollments(actor.schoolId, studentId)).find((e) => e.status === "ENROLLED");
      if (!current) return fail("no_current_enrollment");
      const year = await repo.findYearRef(actor.schoolId, current.academicYearId);
      if (!year) return fail("no_current_enrollment");
      if (year.status === "CLOSED") return fail("year_closed", { academicYearId: "This academic year is closed." });
      if (!cls.isActive) return fail("class_inactive", { classId: "This class is inactive. Choose an active class." });
      if (cls.id === current.classId) return fail("validation_error", { classId: "The student is already in this class." });

      const effective = typeof input.effectiveDate === "string" ? input.effectiveDate : todayOf(now);
      if (effective <= current.startDate) return fail("validation_error", { effectiveDate: "The class change must start after the current enrollment began, so that history is kept." });
      if (effective > year.endDate) return fail("validation_error", { effectiveDate: "The date is after the end of the academic year." });

      const result = await repo.transferEnrollment(actor.schoolId, current.id, dayBefore(effective), {
        studentId, classId: cls.id, academicYearId: year.id, startDate: effective, endDate: year.endDate,
      });
      if (!result) return fail("not_found");
      await makeAudit(repo, actor)("enrollment.class_changed", "enrollment", result.created.id, {
        studentId, fromClassId: current.classId, toClassId: cls.id, academicYearId: year.id, fromEnrollmentId: current.id,
      });
      return ok(result);
    }, { field: "effectiveDate", message: "This student's enrollment has just changed. Reload and try again." });
  }

  /** The students of one class in one academic year. Both must belong to the school, or the answer is "not found". */
  async function roster(actor: Actor, classId: string, academicYearId: string, includeEnded: boolean): Promise<Result<Roster>> {
    const [cls, year] = await Promise.all([repo.findClassRef(actor.schoolId, classId), repo.findYearRef(actor.schoolId, academicYearId)]);
    if (!cls || !year) return fail("not_found");
    return ok({ class: cls, academicYear: year, entries: await repo.listRoster(actor.schoolId, classId, academicYearId, includeEnded) });
  }

  return { list, enroll, transfer, roster };
}

export type EnrollmentService = ReturnType<typeof createEnrollmentService>;
