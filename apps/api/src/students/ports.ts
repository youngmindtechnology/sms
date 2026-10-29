import type { AuditEventInput } from "../auth/ports.js";

/** Stored values; they mirror the database enums exactly. */
export const STUDENT_STATUSES = ["ACTIVE", "WITHDRAWN", "TRANSFERRED_OUT", "GRADUATED"] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const GUARDIAN_RELATIONSHIPS = [
  "MOTHER", "FATHER", "GRANDPARENT", "SIBLING", "UNCLE_OR_AUNT", "OTHER_RELATIVE", "LEGAL_GUARDIAN", "OTHER",
] as const;
export type GuardianRelationship = (typeof GUARDIAN_RELATIONSHIPS)[number];

export type EnrollmentStatus = "ENROLLED" | "PROMOTED" | "REPEATED" | "CLASS_CHANGED" | "WITHDRAWN" | "COMPLETED";

/** Dates are plain calendar dates ("YYYY-MM-DD"), never timestamps. */
export interface StudentRecord {
  id: string;
  admissionNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string | null;
  admittedOn: string | null;
  status: StudentStatus;
}

export interface NewStudent {
  admissionNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string | null;
  admittedOn: string | null;
}
export type StudentPatch = Partial<Omit<NewStudent, "admissionNumber">> & { admissionNumber?: string };

/** The small shape used in lists and rosters: no date of birth, no contact details. */
export interface StudentSummary {
  id: string;
  admissionNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  status: StudentStatus;
}

export interface CurrentPlacement {
  enrollmentId: string;
  classId: string;
  className: string;
  academicYearId: string;
  academicYearName: string;
}
export interface StudentListItem extends StudentSummary { current: CurrentPlacement | null }

export interface StudentQuery {
  /** Lower-case search words; every word must match the first, middle or last name. */
  nameTerms: string[];
  /** Upper-case text the admission number must contain, or null when the search cannot be part of an admission number. */
  admissionText: string | null;
  status: StudentStatus | null;
  /** Only students currently enrolled in this class. */
  classId: string | null;
  page: number;
  pageSize: number;
}

export interface GuardianRecord { id: string; fullName: string; phone: string | null; email: string | null }
export interface NewGuardian { fullName: string; phone: string | null; email: string | null }
export type GuardianPatch = Partial<NewGuardian>;

/** A guardian as seen from one student. */
export interface GuardianLink extends GuardianRecord { relationship: GuardianRelationship; isPrimaryContact: boolean }
export interface LinkRecord { studentId: string; guardianId: string; relationship: GuardianRelationship; isPrimaryContact: boolean }
export interface LinkPatch { relationship?: GuardianRelationship; isPrimaryContact?: boolean }

export interface EnrollmentRecord {
  id: string;
  studentId: string;
  classId: string;
  className: string;
  academicYearId: string;
  academicYearName: string;
  status: EnrollmentStatus;
  startDate: string;
  endDate: string | null;
}
export interface NewEnrollment { studentId: string; classId: string; academicYearId: string; startDate: string; endDate: string }

export interface RosterEntry { enrollmentId: string; status: EnrollmentStatus; startDate: string; endDate: string | null; student: StudentSummary }

export interface ClassRef { id: string; name: string; isActive: boolean }
export interface YearRef { id: string; name: string; status: "PLANNED" | "ACTIVE" | "CLOSED"; startDate: string; endDate: string }

/**
 * Every method takes the school id FIRST and applies it to every query; the id always comes from
 * the verified session, never from the request. A record in another school is indistinguishable
 * from a missing one (null / false). There is deliberately no way to delete a student, a guardian
 * or an enrollment: history is kept. The only row that is ever removed is a student-guardian link.
 *
 * Methods that change several rows are atomic: everything is saved, or nothing is.
 */
export interface StudentRepository {
  // ----- students -----
  listStudents(schoolId: string, query: StudentQuery): Promise<{ items: StudentListItem[]; total: number }>;
  countStudents(schoolId: string): Promise<number>;
  findStudent(schoolId: string, studentId: string): Promise<StudentRecord | null>;
  createStudent(schoolId: string, input: NewStudent): Promise<StudentRecord>;
  updateStudent(schoolId: string, studentId: string, patch: StudentPatch): Promise<StudentRecord | null>;
  /**
   * Atomically sets the status and, when `closeOpenEnrollments` is given, ends every ENROLLED
   * enrollment of the student with that status. The end date is the effective date, or the
   * enrollment's own earlier end date, whichever comes first (the end date is the inclusive last day).
   */
  setStudentStatus(
    schoolId: string, studentId: string, status: StudentStatus,
    closeOpenEnrollments: { status: EnrollmentStatus; effectiveDate: string } | null,
  ): Promise<{ student: StudentRecord; closedEnrollmentIds: string[] } | null>;

  // ----- guardians and links -----
  findGuardian(schoolId: string, guardianId: string): Promise<GuardianRecord | null>;
  /** Substring match on name or phone; at most `limit` results, newest first. */
  searchGuardians(schoolId: string, term: string, limit: number): Promise<GuardianRecord[]>;
  updateGuardian(schoolId: string, guardianId: string, patch: GuardianPatch): Promise<GuardianRecord | null>;
  listGuardianLinks(schoolId: string, studentId: string): Promise<GuardianLink[]>;
  listLinkedStudents(schoolId: string, guardianId: string): Promise<Array<StudentSummary & { relationship: GuardianRelationship; isPrimaryContact: boolean }>>;
  findLink(schoolId: string, studentId: string, guardianId: string): Promise<LinkRecord | null>;
  /** Atomic. Becoming primary demotes the student's previous primary guardian. Throws RepositoryConflict("duplicate") if already linked. */
  linkGuardian(schoolId: string, studentId: string, guardianId: string, relationship: GuardianRelationship, isPrimaryContact: boolean): Promise<LinkRecord | null>;
  /** Atomic: creates the guardian and links it, or does neither. */
  createGuardianAndLink(
    schoolId: string, studentId: string, guardian: NewGuardian, relationship: GuardianRelationship, isPrimaryContact: boolean,
  ): Promise<{ guardian: GuardianRecord; link: LinkRecord } | null>;
  /** Atomic. Becoming primary demotes the previous primary guardian. */
  updateLink(schoolId: string, studentId: string, guardianId: string, patch: LinkPatch): Promise<LinkRecord | null>;
  /** Removes only the link; the guardian and the student stay. False when there was no such link. */
  unlinkGuardian(schoolId: string, studentId: string, guardianId: string): Promise<boolean>;

  // ----- enrollments -----
  findClassRef(schoolId: string, classId: string): Promise<ClassRef | null>;
  findYearRef(schoolId: string, yearId: string): Promise<YearRef | null>;
  /** Newest first. */
  listEnrollments(schoolId: string, studentId: string): Promise<EnrollmentRecord[]>;
  /** Throws RepositoryConflict("overlap") when the student already has an enrollment in that period. */
  createEnrollment(schoolId: string, input: NewEnrollment): Promise<EnrollmentRecord>;
  /**
   * Atomic class change: the old enrollment ends (status CLASS_CHANGED, inclusive end date) and the
   * new one starts, or neither happens. The old row is kept as history. Null when the old enrollment
   * is not found.
   */
  transferEnrollment(
    schoolId: string, fromEnrollmentId: string, oldEndDate: string, next: NewEnrollment,
  ): Promise<{ ended: EnrollmentRecord; created: EnrollmentRecord } | null>;
  /** Students of one class and year, ordered by last then first name. `includeEnded` adds students who have left the class. */
  listRoster(schoolId: string, classId: string, academicYearId: string, includeEnded: boolean): Promise<RosterEntry[]>;

  appendAudit(event: AuditEventInput): Promise<void>;
}
