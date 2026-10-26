import { randomUUID } from "node:crypto";
import type { AuditEventInput } from "../auth/ports.js";
import { rangesOverlap } from "../academic/dates.js";
import {
  RepositoryConflict,
  type AcademicRepository, type NewTerm, type NewYear, type TermPatch, type TermRecord, type YearPatch, type YearRecord,
} from "../academic/ports.js";

type YearRow = YearRecord & { schoolId: string };
type TermRow = TermRecord & { schoolId: string };

/**
 * In-memory stand-in for the database, used only by tests. It also enforces the same
 * rules the real database does (unique names, no overlap, one ACTIVE year/term per
 * school), so tests can prove the service survives a database refusal.
 */
export class MemoryAcademicRepository implements AcademicRepository {
  years: YearRow[] = [];
  terms: TermRow[] = [];
  audit: AuditEventInput[] = [];
  /** Test hook: make the next write fail part-way to prove nothing is half-saved. */
  failNextActivation = false;

  private strip<T extends { schoolId: string }>(row: T): Omit<T, "schoolId"> {
    const { schoolId: _s, ...rest } = row;
    return rest;
  }
  private year(schoolId: string, id: string) { return this.years.find((y) => y.id === id && y.schoolId === schoolId); }
  private term(schoolId: string, yearId: string, id: string) {
    return this.terms.find((t) => t.id === id && t.academicYearId === yearId && t.schoolId === schoolId);
  }

  async listYears(schoolId: string) {
    return this.years.filter((y) => y.schoolId === schoolId).sort((a, b) => b.startDate.localeCompare(a.startDate)).map((y) => this.strip(y));
  }
  async findYear(schoolId: string, id: string) { const y = this.year(schoolId, id); return y ? this.strip(y) : null; }

  async createYear(schoolId: string, input: NewYear) {
    const mine = this.years.filter((y) => y.schoolId === schoolId);
    if (mine.some((y) => y.name === input.name)) throw new RepositoryConflict("duplicate");
    if (mine.some((y) => rangesOverlap(y, input))) throw new RepositoryConflict("overlap");
    const row: YearRow = { id: randomUUID(), schoolId, status: "PLANNED", ...input };
    this.years.push(row);
    return this.strip(row);
  }

  async updateYear(schoolId: string, id: string, patch: YearPatch) {
    const row = this.year(schoolId, id);
    if (!row) return null;
    Object.assign(row, patch);
    return this.strip(row);
  }

  async activateYear(schoolId: string, id: string) {
    const row = this.year(schoolId, id);
    if (!row) return null;
    // All-or-nothing: work on copies, commit at the end.
    const before = { years: this.years.map((y) => ({ ...y })), terms: this.terms.map((t) => ({ ...t })) };
    try {
      const previous = this.years.find((y) => y.schoolId === schoolId && y.status === "ACTIVE");
      if (previous) {
        previous.status = "CLOSED";
        for (const t of this.terms) if (t.academicYearId === previous.id && t.status === "ACTIVE") t.status = "CLOSED";
      }
      if (this.failNextActivation) { this.failNextActivation = false; throw new Error("simulated database failure"); }
      row.status = "ACTIVE";
      return { year: this.strip(row), closedYearId: previous?.id ?? null };
    } catch (error) {
      this.years = before.years; this.terms = before.terms;
      throw error;
    }
  }

  async closeYear(schoolId: string, id: string) {
    const row = this.year(schoolId, id);
    if (!row) return null;
    row.status = "CLOSED";
    for (const t of this.terms) if (t.academicYearId === id && t.status === "ACTIVE") t.status = "CLOSED";
    return this.strip(row);
  }

  async listTerms(schoolId: string, yearId: string) {
    return this.terms.filter((t) => t.schoolId === schoolId && t.academicYearId === yearId).sort((a, b) => a.sequence - b.sequence).map((t) => this.strip(t));
  }
  async findTerm(schoolId: string, yearId: string, id: string) { const t = this.term(schoolId, yearId, id); return t ? this.strip(t) : null; }

  async createTerm(schoolId: string, yearId: string, input: NewTerm) {
    if (!this.year(schoolId, yearId)) return null;
    const siblings = this.terms.filter((t) => t.academicYearId === yearId);
    if (siblings.some((t) => t.name === input.name || t.sequence === input.sequence)) throw new RepositoryConflict("duplicate");
    if (siblings.some((t) => rangesOverlap(t, input))) throw new RepositoryConflict("overlap");
    const row: TermRow = { id: randomUUID(), schoolId, academicYearId: yearId, status: "PLANNED", ...input };
    this.terms.push(row);
    return this.strip(row);
  }

  async updateTerm(schoolId: string, yearId: string, id: string, patch: TermPatch) {
    const row = this.term(schoolId, yearId, id);
    if (!row) return null;
    Object.assign(row, patch);
    return this.strip(row);
  }

  async activateTerm(schoolId: string, yearId: string, id: string) {
    const row = this.term(schoolId, yearId, id);
    if (!row) return null;
    const previous = this.terms.find((t) => t.schoolId === schoolId && t.status === "ACTIVE");
    if (previous) previous.status = "CLOSED";
    row.status = "ACTIVE";
    return { term: this.strip(row), closedTermId: previous?.id ?? null };
  }

  async closeTerm(schoolId: string, yearId: string, id: string) {
    const row = this.term(schoolId, yearId, id);
    if (!row) return null;
    row.status = "CLOSED";
    return this.strip(row);
  }

  async appendAudit(event: AuditEventInput) { this.audit.push(event); }
}
