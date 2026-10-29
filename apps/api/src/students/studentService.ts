import { RepositoryConflict } from "../academic/ports.js";
import { fail, makeAudit, ok, redactGuardian, redactStudent, todayOf, type Actor, type Result } from "./common.js";
import type {
  EnrollmentRecord, EnrollmentStatus, GuardianLink, StudentListItem, StudentPatch, StudentRecord, StudentRepository, StudentStatus,
} from "./ports.js";
import { cleanAdmissionNumber, cleanOptionalDate, cleanOptionalText, cleanText, isStudentStatus, yearsBefore } from "./validation.js";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const ADMISSION_SEARCH = /^[A-Z0-9/._-]{1,40}$/;

/** A status can only change to or from ACTIVE. Moving between two ended states goes through ACTIVE first. */
const ALLOWED: Record<StudentStatus, readonly StudentStatus[]> = {
  ACTIVE: ["WITHDRAWN", "TRANSFERRED_OUT", "GRADUATED"],
  WITHDRAWN: ["ACTIVE"],
  TRANSFERRED_OUT: ["ACTIVE"],
  GRADUATED: ["ACTIVE"],
};
const ENDING_ENROLLMENT: Record<Exclude<StudentStatus, "ACTIVE">, EnrollmentStatus> = {
  WITHDRAWN: "WITHDRAWN", TRANSFERRED_OUT: "WITHDRAWN", GRADUATED: "COMPLETED",
};

export interface StudentProfile {
  student: StudentRecord;
  guardians: GuardianLink[];
  enrollments: EnrollmentRecord[];
  /** The enrollment that is open right now, if any. */
  current: EnrollmentRecord | null;
}

export interface ListInput { search?: unknown; status?: unknown; classId?: string; page?: unknown; pageSize?: unknown }

export function createStudentService(repo: StudentRepository, now: () => Date = () => new Date()) {
  /** A duplicate admission number is the only unique rule on students. */
  async function guard<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RepositoryConflict) return fail("duplicate_admission_number", { admissionNumber: "This admission number is already used in your school." });
      throw error;
    }
  }

  async function list(actor: Actor, input: ListInput): Promise<Result<{ items: StudentListItem[]; total: number; page: number; pageSize: number }>> {
    const errors: Record<string, string> = {};
    const page = input.page === undefined ? 1 : input.page;
    const pageSize = input.pageSize === undefined ? DEFAULT_PAGE_SIZE : input.pageSize;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > 10_000) errors.page = "The page must be a whole number from 1.";
    if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) errors.pageSize = `The page size must be from 1 to ${MAX_PAGE_SIZE}.`;
    let status: StudentStatus | null = null;
    if (input.status !== undefined && input.status !== "") {
      if (isStudentStatus(input.status)) status = input.status; else errors.status = "Choose a valid status.";
    }
    let search = "";
    if (input.search !== undefined) {
      if (typeof input.search !== "string" || input.search.length > 100) errors.search = "The search text must be at most 100 characters.";
      else search = input.search.trim().replace(/\s+/g, " ");
    }
    if (Object.keys(errors).length) return fail("validation_error", errors);

    const words = search === "" ? [] : search.toLowerCase().split(" ").slice(0, 5);
    const upper = search.toUpperCase();
    const result = await repo.listStudents(actor.schoolId, {
      nameTerms: words,
      admissionText: search !== "" && ADMISSION_SEARCH.test(upper) ? upper : null,
      status,
      classId: input.classId ?? null,
      page: page as number,
      pageSize: pageSize as number,
    });
    return ok({ ...result, page: page as number, pageSize: pageSize as number });
  }

  function register(
    actor: Actor,
    input: { admissionNumber?: unknown; firstName?: unknown; middleName?: unknown; lastName?: unknown; dateOfBirth?: unknown; admittedOn?: unknown },
  ): Promise<Result<StudentRecord>> {
    return guard(async () => {
      const errors: Record<string, string> = {};
      const today = todayOf(now);
      const firstName = cleanText(input.firstName, "firstName", "the first name", 100, errors);
      const lastName = cleanText(input.lastName, "lastName", "the last name", 100, errors);
      const middleName = cleanOptionalText(input.middleName, "middleName", "the middle name", 100, errors);
      const dateOfBirth = cleanOptionalDate(input.dateOfBirth, "dateOfBirth", "date of birth", errors, { max: today, min: yearsBefore(today, 30) });
      const admittedOn = cleanOptionalDate(input.admittedOn, "admittedOn", "admission date", errors, { min: "2000-01-01" });
      const supplied = input.admissionNumber === undefined || input.admissionNumber === null || input.admissionNumber === ""
        ? null
        : cleanAdmissionNumber(input.admissionNumber, errors);
      if (dateOfBirth && admittedOn && admittedOn < dateOfBirth) errors.admittedOn = "The admission date can't be before the date of birth.";
      if (!firstName || !lastName || Object.keys(errors).length) return fail("validation_error", errors);

      const base = { firstName, middleName: middleName ?? null, lastName, dateOfBirth: dateOfBirth ?? null, admittedOn: admittedOn ?? null };
      let created: StudentRecord;
      if (supplied) {
        created = await repo.createStudent(actor.schoolId, { ...base, admissionNumber: supplied });
      } else {
        // Generated numbers look like 2026/0007. Another request may take the number first; the
        // database's unique index is the referee, so try the next one a few times.
        const year = (admittedOn ?? today).slice(0, 4);
        const start = (await repo.countStudents(actor.schoolId)) + 1;
        let made: StudentRecord | null = null;
        for (let attempt = 0; attempt < 8 && !made; attempt += 1) {
          try {
            made = await repo.createStudent(actor.schoolId, { ...base, admissionNumber: `${year}/${String(start + attempt).padStart(4, "0")}` });
          } catch (error) {
            if (!(error instanceof RepositoryConflict)) throw error;
          }
        }
        if (!made) return fail("duplicate_admission_number", { admissionNumber: "A number couldn't be generated. Enter an admission number yourself." });
        created = made;
      }
      await makeAudit(repo, actor)("student.created", "student", created.id, { generatedAdmissionNumber: !supplied });
      return ok(redactStudent(created, actor));
    });
  }

  async function profile(actor: Actor, studentId: string): Promise<Result<StudentProfile>> {
    const student = await repo.findStudent(actor.schoolId, studentId);
    if (!student) return fail("not_found");
    const [guardians, enrollments] = await Promise.all([repo.listGuardianLinks(actor.schoolId, studentId), repo.listEnrollments(actor.schoolId, studentId)]);
    return ok({ student: redactStudent(student, actor), guardians: guardians.map((g) => redactGuardian(g, actor)), enrollments, current: enrollments.find((e) => e.status === "ENROLLED") ?? null });
  }

  function update(
    actor: Actor, studentId: string,
    patch: { admissionNumber?: unknown; firstName?: unknown; middleName?: unknown; lastName?: unknown; dateOfBirth?: unknown; admittedOn?: unknown },
  ): Promise<Result<StudentRecord>> {
    return guard(async () => {
      const current = await repo.findStudent(actor.schoolId, studentId);
      if (!current) return fail("not_found");

      const errors: Record<string, string> = {};
      const today = todayOf(now);
      const next: StudentPatch = {};
      if (patch.admissionNumber !== undefined) { const v = cleanAdmissionNumber(patch.admissionNumber, errors); if (v) next.admissionNumber = v; }
      if (patch.firstName !== undefined) { const v = cleanText(patch.firstName, "firstName", "the first name", 100, errors); if (v) next.firstName = v; }
      if (patch.lastName !== undefined) { const v = cleanText(patch.lastName, "lastName", "the last name", 100, errors); if (v) next.lastName = v; }
      if (patch.middleName !== undefined) { const v = cleanOptionalText(patch.middleName, "middleName", "the middle name", 100, errors); if (v !== undefined) next.middleName = v; }
      if (patch.dateOfBirth !== undefined) {
        const v = cleanOptionalDate(patch.dateOfBirth, "dateOfBirth", "date of birth", errors, { max: today, min: yearsBefore(today, 30) });
        if (v !== undefined) next.dateOfBirth = v;
      }
      if (patch.admittedOn !== undefined) {
        const v = cleanOptionalDate(patch.admittedOn, "admittedOn", "admission date", errors, { min: "2000-01-01" });
        if (v !== undefined) next.admittedOn = v;
      }
      const dob = next.dateOfBirth !== undefined ? next.dateOfBirth : current.dateOfBirth;
      const adm = next.admittedOn !== undefined ? next.admittedOn : current.admittedOn;
      if (dob && adm && adm < dob && !errors.admittedOn && !errors.dateOfBirth) errors.admittedOn = "The admission date can't be before the date of birth.";
      if (Object.keys(errors).length) return fail("validation_error", errors);
      if (Object.keys(next).length === 0) return fail("validation_error", { body: "Nothing to change." });

      const updated = await repo.updateStudent(actor.schoolId, studentId, next);
      if (!updated) return fail("not_found");
      await makeAudit(repo, actor)("student.updated", "student", studentId, { changed: Object.keys(next) });
      return ok(redactStudent(updated, actor));
    });
  }

  /**
   * Withdrawing, transferring out or graduating a student ends the student's open enrollment in the
   * same atomic step (so the roster and the status never disagree). Nothing is deleted; reactivating
   * a student does not re-enroll them.
   */
  async function changeStatus(actor: Actor, studentId: string, input: { status?: unknown; effectiveDate?: unknown }): Promise<Result<{ student: StudentRecord; closedEnrollmentIds: string[] }>> {
    const student = await repo.findStudent(actor.schoolId, studentId);
    if (!student) return fail("not_found");

    const errors: Record<string, string> = {};
    if (!isStudentStatus(input.status)) errors.status = "Choose a valid status.";
    const today = todayOf(now);
    const effective = cleanOptionalDate(input.effectiveDate, "effectiveDate", "date", errors, { max: today, min: "2000-01-01" }) ?? today;
    if (Object.keys(errors).length) return fail("validation_error", errors);

    const target = input.status as StudentStatus;
    if (target === student.status || !ALLOWED[student.status].includes(target)) {
      return fail("invalid_status_change", { status: student.status === target ? "The student already has this status." : "That status change isn't allowed. Reactivate the student first." });
    }

    let close: { status: EnrollmentStatus; effectiveDate: string } | null = null;
    if (target !== "ACTIVE") {
      const open = (await repo.listEnrollments(actor.schoolId, studentId)).filter((e) => e.status === "ENROLLED");
      if (open.some((e) => effective < e.startDate)) return fail("validation_error", { effectiveDate: "The date is before the student's enrollment started." });
      if (open.length > 0) close = { status: ENDING_ENROLLMENT[target], effectiveDate: effective };
    }

    const result = await repo.setStudentStatus(actor.schoolId, studentId, target, close);
    if (!result) return fail("not_found");
    const audit = makeAudit(repo, actor);
    await audit("student.status_changed", "student", studentId, { from: student.status, to: target, effectiveDate: effective, closedEnrollments: result.closedEnrollmentIds.length });
    for (const id of result.closedEnrollmentIds) await audit("enrollment.ended", "enrollment", id, { studentId, reason: target });
    return ok({ ...result, student: redactStudent(result.student, actor) });
  }

  return { list, register, profile, update, changeStatus };
}

export type StudentService = ReturnType<typeof createStudentService>;
