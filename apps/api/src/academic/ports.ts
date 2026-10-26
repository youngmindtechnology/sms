import type { AuditEventInput } from "../auth/ports.js";

export type PeriodStatus = "PLANNED" | "ACTIVE" | "CLOSED";

/** Dates are plain calendar dates ("YYYY-MM-DD"), never timestamps, so time zones cannot shift them. */
export interface YearRecord {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
}

export interface TermRecord {
  id: string;
  academicYearId: string;
  name: string;
  sequence: number;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
}

export interface NewYear { name: string; startDate: string; endDate: string }
export interface YearPatch { name?: string; startDate?: string; endDate?: string }
export interface NewTerm { name: string; sequence: number; startDate: string; endDate: string }
export interface TermPatch { name?: string; sequence?: number; startDate?: string; endDate?: string }

/** Thrown by a repository when the database itself refuses a write (duplicate or overlap). */
export class RepositoryConflict extends Error {
  constructor(readonly kind: "duplicate" | "overlap") {
    super(kind);
    this.name = "RepositoryConflict";
  }
}

/**
 * Every method takes the school id FIRST and applies it to every query. The id always comes
 * from the verified session, never from the request. A record that exists in another school
 * is indistinguishable from one that does not exist (null).
 *
 * The activate and close methods are atomic: either every related change is saved, or none is.
 */
export interface AcademicRepository {
  listYears(schoolId: string): Promise<YearRecord[]>;
  findYear(schoolId: string, yearId: string): Promise<YearRecord | null>;
  createYear(schoolId: string, input: NewYear): Promise<YearRecord>;
  updateYear(schoolId: string, yearId: string, patch: YearPatch): Promise<YearRecord | null>;
  /** Makes the year ACTIVE; the school's previously ACTIVE year and its ACTIVE term become CLOSED. */
  activateYear(schoolId: string, yearId: string): Promise<{ year: YearRecord; closedYearId: string | null } | null>;
  /** Closes the year and any ACTIVE term inside it. */
  closeYear(schoolId: string, yearId: string): Promise<YearRecord | null>;

  listTerms(schoolId: string, yearId: string): Promise<TermRecord[]>;
  findTerm(schoolId: string, yearId: string, termId: string): Promise<TermRecord | null>;
  createTerm(schoolId: string, yearId: string, input: NewTerm): Promise<TermRecord | null>;
  updateTerm(schoolId: string, yearId: string, termId: string, patch: TermPatch): Promise<TermRecord | null>;
  /** Makes the term ACTIVE; the school's previously ACTIVE term becomes CLOSED. */
  activateTerm(schoolId: string, yearId: string, termId: string): Promise<{ term: TermRecord; closedTermId: string | null } | null>;
  closeTerm(schoolId: string, yearId: string, termId: string): Promise<TermRecord | null>;

  appendAudit(event: AuditEventInput): Promise<void>;
}
