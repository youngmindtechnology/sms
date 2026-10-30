import type { AuditEventInput } from "../auth/ports.js";

export interface ClassRef { id: string; name: string; isActive: boolean }
export interface YearRef { id: string; name: string; status: "PLANNED" | "ACTIVE" | "CLOSED" }

export interface SubjectRecord {
  id: string;
  classId: string;
  name: string;
  code: string | null;
  isActive: boolean;
}

export type AssignmentStatus = "ACTIVE" | "ENDED";

/** A teacher appears as a membership id and a name only: no user id, e-mail or credential data. */
export interface AssignmentRecord {
  id: string;
  subjectId: string;
  academicYearId: string;
  academicYearName: string;
  teacherMembershipId: string;
  teacherName: string;
  status: AssignmentStatus;
  /** ISO timestamps. */
  endedAt: string | null;
  createdAt: string;
}

export interface EligibleTeacher { membershipId: string; fullName: string }

export interface NewSubject { classId: string; name: string; code: string | null }
export interface SubjectPatch { name?: string; code?: string | null; isActive?: boolean }

/** What the service wants written to the audit trail together with an assignment change. */
export interface AuditDraft { actorUserId: string; action: string; metadata: Record<string, unknown> }

/**
 * The database (or the in-memory fake) refused a write. `kind` says which rule:
 *  - name / code: a subject with that name or code already exists in the class
 *  - assignment:  the teacher already has an ACTIVE assignment for that subject and year
 *  - teacher:     the teacher is not (or is no longer) eligible
 *  - state:       the subject, class or year changed in the meantime (inactive subject, closed year...)
 *  - stale:       the assignment was ended by another request first
 */
export class SubjectConflict extends Error {
  constructor(readonly kind: "name" | "code" | "assignment" | "teacher" | "state" | "stale") {
    super(kind);
    this.name = "SubjectConflict";
  }
}

/**
 * Every method takes the school id FIRST and applies it to every query; the id always comes from the
 * verified session, never from the request. A record in another school is indistinguishable from a
 * missing one (null). There is deliberately no delete: subjects and assignments are history.
 *
 * Methods that change several rows are atomic. The assignment writes RE-CHECK, inside the same
 * transaction and with the rows locked, that the teacher is still eligible, the subject is active
 * and the year is not closed, so a change made by another request a moment earlier cannot slip through.
 */
export interface SubjectRepository {
  findClass(schoolId: string, classId: string): Promise<ClassRef | null>;
  findYear(schoolId: string, yearId: string): Promise<YearRef | null>;
  /** Ordered by name. Includes inactive subjects. */
  listSubjects(schoolId: string, classId: string): Promise<SubjectRecord[]>;
  findSubject(schoolId: string, subjectId: string): Promise<SubjectRecord | null>;
  /** Throws SubjectConflict("name" | "code"). */
  createSubject(schoolId: string, input: NewSubject): Promise<SubjectRecord>;
  /** Throws SubjectConflict("name" | "code"). Null when the subject is not in this school. */
  updateSubject(schoolId: string, subjectId: string, patch: SubjectPatch): Promise<SubjectRecord | null>;
  appendAudit(event: AuditEventInput): Promise<void>;

  /** ACTIVE assignments of every subject of the class for one year, ordered by teacher name. */
  listActiveAssignmentsForClass(schoolId: string, classId: string, academicYearId: string): Promise<AssignmentRecord[]>;
  /** Newest first. With `academicYearId` only that year; ended ones only with `includeEnded`. */
  listAssignments(schoolId: string, subjectId: string, opts: { academicYearId?: string; includeEnded: boolean }): Promise<AssignmentRecord[]>;
  findAssignment(schoolId: string, assignmentId: string): Promise<AssignmentRecord | null>;
  /** The membership as a teacher candidate, or null if it is not in this school. `eligible` is checked now. */
  findTeacher(schoolId: string, membershipId: string): Promise<(EligibleTeacher & { eligible: boolean }) | null>;
  listEligibleTeachers(schoolId: string): Promise<EligibleTeacher[]>;

  /**
   * Atomic: re-checks eligibility, subject and year, creates the assignment and writes its audit event.
   * Throws SubjectConflict("teacher" | "state" | "assignment").
   */
  createAssignment(schoolId: string, input: { subjectId: string; academicYearId: string; teacherMembershipId: string }, audit: AuditDraft): Promise<AssignmentRecord>;
  /**
   * Atomic: ends the old assignment AND creates the new one for another teacher, or neither; the audit
   * event is part of the same transaction. Null when the assignment is not in this school.
   * Throws SubjectConflict("stale" | "teacher" | "state" | "assignment").
   */
  replaceAssignment(schoolId: string, assignmentId: string, teacherMembershipId: string, at: Date, audit: AuditDraft): Promise<{ ended: AssignmentRecord; created: AssignmentRecord } | null>;
  /** Atomic with its audit event. Null when not in this school. Throws SubjectConflict("stale") if already ended. */
  endAssignment(schoolId: string, assignmentId: string, at: Date, audit: AuditDraft): Promise<AssignmentRecord | null>;
}
