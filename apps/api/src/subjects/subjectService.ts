import { assertAuditSafe } from "../auth/audit.js";
import {
  SubjectConflict,
  type AssignmentRecord, type AuditDraft, type ClassRef, type EligibleTeacher, type SubjectPatch, type SubjectRecord, type SubjectRepository, type YearRef,
} from "./ports.js";

export interface Actor { schoolId: string; userId: string }

export type SubjectErrorCode =
  | "validation_error" | "not_found"
  | "duplicate_name" | "duplicate_code"
  | "class_inactive" | "subject_inactive" | "year_closed"
  | "teacher_not_eligible" | "already_assigned" | "assignment_ended";
export type Result<T> = { ok: true; value: T } | { ok: false; error: SubjectErrorCode; fields?: Record<string, string> };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: SubjectErrorCode, fields?: Record<string, string>): Result<never> => ({ ok: false, error, fields });
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** Trim and squeeze inner spaces, so "Integrated  Science " and "Integrated Science" are the same subject. */
function checkName(value: unknown, errors: Record<string, string>): string | null {
  if (typeof value !== "string") { errors.name = "Enter a name."; return null; }
  const name = value.trim().replace(/\s+/g, " ");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) { errors.name = "The name contains characters that aren't allowed."; return null; }
  if (name.length < 1 || name.length > 100) { errors.name = "The name must be 1 to 100 characters."; return null; }
  return name;
}

/** Optional. Stored in capitals (so "math" and "MATH" are one code). Null or blank means no code. */
function checkCode(value: unknown, errors: Record<string, string>): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") { errors.code = "The code must be text."; return undefined; }
  const code = value.trim().toUpperCase();
  if (code === "") return null;
  if (code.length > 20 || !/^[A-Z0-9][A-Z0-9 ._/-]*$/.test(code)) { errors.code = "The code can have up to 20 letters, digits, spaces or . _ / -"; return undefined; }
  return code;
}

export interface SubjectWithTeachers extends SubjectRecord { teachers: AssignmentRecord[] }
export interface ClassSubjects { class: ClassRef; academicYear: YearRef | null; subjects: SubjectWithTeachers[] }

/**
 * Subjects belong to one class; teachers are assigned to a subject for an academic year.
 *  - Several teachers may teach the same subject and year. The SAME teacher cannot be active twice.
 *  - Only an ACTIVE user with an ACTIVE membership holding the TEACHER role in this school can be assigned.
 *  - New assignments need an active subject and a PLANNED or ACTIVE year (never CLOSED).
 *  - Assignments are never deleted: they are ended, or replaced (end + new, all or nothing).
 *  - A teacher suspended or ended later keeps their assignments as history; those can still be ended or replaced.
 */
export function createSubjectService(repo: SubjectRepository, now: () => Date = () => new Date()) {
  const audit = (actor: Actor, action: string, metadata: Record<string, unknown>): AuditDraft => {
    assertAuditSafe(metadata);
    return { actorUserId: actor.userId, action, metadata };
  };

  async function simpleAudit(actor: Actor, action: string, entityId: string, metadata: Record<string, unknown>) {
    assertAuditSafe(metadata);
    await repo.appendAudit({ schoolId: actor.schoolId, actorUserId: actor.userId, action, entityType: "subject", entityId, metadata });
  }

  async function guard<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SubjectConflict) {
        switch (error.kind) {
          case "name": return fail("duplicate_name", { name: "This class already has a subject with this name." });
          case "code": return fail("duplicate_code", { code: "This class already has a subject with this code." });
          case "assignment": return fail("already_assigned", { teacherMembershipId: "This teacher is already assigned to this subject for that year." });
          case "teacher": return fail("teacher_not_eligible", { teacherMembershipId: "This person can no longer be assigned. Reload the page." });
          case "stale": return fail("assignment_ended", { assignmentId: "This assignment has just changed. Reload the page." });
          case "state": return fail("validation_error", { body: "The subject or academic year has just changed. Reload the page and try again." });
        }
      }
      throw error;
    }
  }

  async function checkTeacher(actor: Actor, membershipId: unknown, errors: Record<string, string>) {
    if (!isId(membershipId)) { errors.teacherMembershipId = "Choose a teacher."; return null; }
    const teacher = await repo.findTeacher(actor.schoolId, membershipId);
    if (!teacher) { errors.teacherMembershipId = "Choose a teacher from your school."; return null; }
    return teacher;
  }

  /** The class and, when given, the year. The class must be in this school (missing and foreign look the same). */
  async function listForClass(actor: Actor, classId: string, academicYearId?: string): Promise<Result<ClassSubjects>> {
    const cls = await repo.findClass(actor.schoolId, classId);
    if (!cls) return fail("not_found");
    let year: YearRef | null = null;
    if (academicYearId !== undefined) {
      year = await repo.findYear(actor.schoolId, academicYearId);
      if (!year) return fail("not_found");
    }
    const subjects = await repo.listSubjects(actor.schoolId, classId);
    const assignments = year ? await repo.listActiveAssignmentsForClass(actor.schoolId, classId, year.id) : [];
    return ok({
      class: cls, academicYear: year,
      subjects: subjects.map((s) => ({ ...s, teachers: assignments.filter((a) => a.subjectId === s.id) })),
    });
  }

  function createSubject(actor: Actor, input: { classId?: unknown; name?: unknown; code?: unknown }): Promise<Result<SubjectRecord>> {
    return guard(async () => {
      const errors: Record<string, string> = {};
      const name = checkName(input.name, errors);
      const code = input.code === undefined ? null : checkCode(input.code, errors);
      let cls: ClassRef | null = null;
      if (isId(input.classId)) cls = await repo.findClass(actor.schoolId, input.classId);
      if (!cls) errors.classId = "Choose a class from your school.";
      if (!name || code === undefined || !cls || Object.keys(errors).length) return fail("validation_error", errors);
      if (!cls.isActive) return fail("class_inactive", { classId: "This class is inactive. Choose an active class." });

      const existing = await repo.listSubjects(actor.schoolId, cls.id);
      if (existing.some((s) => same(s.name, name))) return fail("duplicate_name", { name: "This class already has a subject with this name." });
      if (code && existing.some((s) => s.code === code)) return fail("duplicate_code", { code: "This class already has a subject with this code." });

      const created = await repo.createSubject(actor.schoolId, { classId: cls.id, name, code });
      await simpleAudit(actor, "subject.created", created.id, { classId: created.classId });
      return ok(created);
    });
  }

  function updateSubject(actor: Actor, subjectId: string, patch: { name?: unknown; code?: unknown; isActive?: unknown }): Promise<Result<SubjectRecord>> {
    return guard(async () => {
      const current = await repo.findSubject(actor.schoolId, subjectId);
      if (!current) return fail("not_found");

      const errors: Record<string, string> = {};
      const next: SubjectPatch = {};
      if (patch.name !== undefined) { const n = checkName(patch.name, errors); if (n) next.name = n; }
      if (patch.code !== undefined) { const c = checkCode(patch.code, errors); if (c !== undefined) next.code = c; }
      if (patch.isActive !== undefined) { if (typeof patch.isActive === "boolean") next.isActive = patch.isActive; else errors.isActive = "Active must be true or false."; }
      if (Object.keys(errors).length) return fail("validation_error", errors);
      if (Object.keys(next).length === 0) return fail("validation_error", { body: "Nothing to change." });

      const others = (await repo.listSubjects(actor.schoolId, current.classId)).filter((s) => s.id !== subjectId);
      if (next.name && others.some((s) => same(s.name, next.name!))) return fail("duplicate_name", { name: "This class already has a subject with this name." });
      if (next.code && others.some((s) => s.code === next.code)) return fail("duplicate_code", { code: "This class already has a subject with this code." });

      const updated = await repo.updateSubject(actor.schoolId, subjectId, next);
      if (!updated) return fail("not_found");
      const onlyStatus = Object.keys(next).length === 1 && next.isActive !== undefined;
      await simpleAudit(actor, onlyStatus ? (next.isActive ? "subject.reactivated" : "subject.deactivated") : "subject.updated", subjectId, {
        classId: updated.classId, changed: Object.keys(next),
      });
      return ok(updated);
    });
  }

  async function listAssignments(actor: Actor, subjectId: string, opts: { academicYearId?: string; includeEnded: boolean }): Promise<Result<AssignmentRecord[]>> {
    if (!(await repo.findSubject(actor.schoolId, subjectId))) return fail("not_found");
    if (opts.academicYearId !== undefined && !(await repo.findYear(actor.schoolId, opts.academicYearId))) return fail("not_found");
    return ok(await repo.listAssignments(actor.schoolId, subjectId, opts));
  }

  async function eligibleTeachers(actor: Actor): Promise<EligibleTeacher[]> {
    return repo.listEligibleTeachers(actor.schoolId);
  }

  /** Subject must be active and the year open: shared by assign and replace. */
  function checkOpen(subject: SubjectRecord, year: YearRef): Result<never> | null {
    if (!subject.isActive) return fail("subject_inactive", { subjectId: "This subject is inactive. Reactivate it first." });
    if (year.status === "CLOSED") return fail("year_closed", { academicYearId: "This academic year is closed." });
    return null;
  }

  function assign(actor: Actor, subjectId: string, input: { academicYearId?: unknown; teacherMembershipId?: unknown }): Promise<Result<AssignmentRecord>> {
    return guard(async () => {
      const subject = await repo.findSubject(actor.schoolId, subjectId);
      if (!subject) return fail("not_found");

      const errors: Record<string, string> = {};
      let year: YearRef | null = null;
      if (isId(input.academicYearId)) year = await repo.findYear(actor.schoolId, input.academicYearId);
      if (!year) errors.academicYearId = "Choose an academic year from your school.";
      const teacher = await checkTeacher(actor, input.teacherMembershipId, errors);
      if (!year || !teacher || Object.keys(errors).length) return fail("validation_error", errors);

      const blocked = checkOpen(subject, year);
      if (blocked) return blocked;
      if (!teacher.eligible) return fail("teacher_not_eligible", { teacherMembershipId: "Only active teachers can be assigned." });
      const existing = await repo.listAssignments(actor.schoolId, subjectId, { academicYearId: year.id, includeEnded: false });
      if (existing.some((a) => a.teacherMembershipId === teacher.membershipId)) {
        return fail("already_assigned", { teacherMembershipId: "This teacher is already assigned to this subject for that year." });
      }

      const created = await repo.createAssignment(
        actor.schoolId, { subjectId, academicYearId: year.id, teacherMembershipId: teacher.membershipId },
        audit(actor, "teaching_assignment.created", { subjectId, academicYearId: year.id, teacherMembershipId: teacher.membershipId }),
      );
      return ok(created);
    });
  }

  /** End one teacher's assignment and start another teacher's on the same subject and year, all or nothing. */
  function replace(actor: Actor, assignmentId: string, input: { teacherMembershipId?: unknown }): Promise<Result<{ ended: AssignmentRecord; created: AssignmentRecord }>> {
    return guard(async () => {
      const current = await repo.findAssignment(actor.schoolId, assignmentId);
      if (!current) return fail("not_found");
      if (current.status !== "ACTIVE") return fail("assignment_ended", { assignmentId: "This assignment has already ended." });

      const errors: Record<string, string> = {};
      const teacher = await checkTeacher(actor, input.teacherMembershipId, errors);
      if (!teacher || Object.keys(errors).length) return fail("validation_error", errors);

      const subject = await repo.findSubject(actor.schoolId, current.subjectId);
      const year = await repo.findYear(actor.schoolId, current.academicYearId);
      if (!subject || !year) return fail("not_found");
      const blocked = checkOpen(subject, year);
      if (blocked) return blocked;
      if (teacher.membershipId === current.teacherMembershipId) return fail("validation_error", { teacherMembershipId: "This teacher already has the assignment. Choose someone else." });
      if (!teacher.eligible) return fail("teacher_not_eligible", { teacherMembershipId: "Only active teachers can be assigned." });
      const existing = await repo.listAssignments(actor.schoolId, current.subjectId, { academicYearId: year.id, includeEnded: false });
      if (existing.some((a) => a.teacherMembershipId === teacher.membershipId)) {
        return fail("already_assigned", { teacherMembershipId: "This teacher is already assigned to this subject for that year." });
      }

      const result = await repo.replaceAssignment(
        actor.schoolId, assignmentId, teacher.membershipId, now(),
        audit(actor, "teaching_assignment.replaced", {
          subjectId: current.subjectId, academicYearId: current.academicYearId,
          fromAssignmentId: assignmentId, fromTeacherMembershipId: current.teacherMembershipId, toTeacherMembershipId: teacher.membershipId,
        }),
      );
      if (!result) return fail("not_found");
      return ok(result);
    });
  }

  /** Ending keeps the row as history. Allowed even if the teacher has left or the year is closed. */
  function end(actor: Actor, assignmentId: string): Promise<Result<AssignmentRecord>> {
    return guard(async () => {
      const current = await repo.findAssignment(actor.schoolId, assignmentId);
      if (!current) return fail("not_found");
      if (current.status !== "ACTIVE") return fail("assignment_ended", { assignmentId: "This assignment has already ended." });
      const ended = await repo.endAssignment(
        actor.schoolId, assignmentId, now(),
        audit(actor, "teaching_assignment.ended", { subjectId: current.subjectId, academicYearId: current.academicYearId, teacherMembershipId: current.teacherMembershipId }),
      );
      if (!ended) return fail("not_found");
      return ok(ended);
    });
  }

  return { listForClass, createSubject, updateSubject, listAssignments, eligibleTeachers, assign, replace, end };
}

export type SubjectService = ReturnType<typeof createSubjectService>;
