import { assertAuditSafe } from "../auth/audit.js";
import { isCalendarDate, isInside, rangesOverlap } from "./dates.js";
import {
  RepositoryConflict,
  type AcademicRepository, type NewTerm, type NewYear, type TermPatch, type TermRecord, type YearPatch, type YearRecord,
} from "./ports.js";

/** The verified caller. Both ids come from the server-side session, never from the request. */
export interface Actor { schoolId: string; userId: string }

export type ErrorCode =
  | "validation_error"
  | "not_found"
  | "duplicate_name"
  | "duplicate_sequence"
  | "dates_overlap"
  | "terms_outside_year"
  | "outside_year"
  | "period_closed"
  | "already_active"
  | "not_active"
  | "year_not_active"
  | "conflict";

export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorCode; fields?: Record<string, string> };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: ErrorCode, fields?: Record<string, string>): Result<never> => ({ ok: false, error, fields });
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function checkName(name: unknown, errors: Record<string, string>, key = "name"): string | null {
  if (typeof name !== "string") { errors[key] = "Enter a name."; return null; }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 50) { errors[key] = "The name must be 1 to 50 characters."; return null; }
  return trimmed;
}

function checkDates(startDate: unknown, endDate: unknown, errors: Record<string, string>) {
  if (!isCalendarDate(startDate)) errors.startDate = "Enter a valid start date.";
  if (!isCalendarDate(endDate)) errors.endDate = "Enter a valid end date.";
  if (errors.startDate || errors.endDate) return null;
  if ((endDate as string) <= (startDate as string)) { errors.endDate = "The end date must be after the start date."; return null; }
  return { startDate: startDate as string, endDate: endDate as string };
}

export function createAcademicService(repo: AcademicRepository) {
  async function audit(actor: Actor, action: string, entityType: string, entityId: string, metadata: Record<string, unknown>) {
    assertAuditSafe(metadata);
    await repo.appendAudit({ schoolId: actor.schoolId, actorUserId: actor.userId, action, entityType, entityId, metadata });
  }

  /** Turns a refusal from the database into a clean answer instead of an internal error. */
  async function guard<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RepositoryConflict) return fail(error.kind === "overlap" ? "dates_overlap" : "duplicate_name");
      throw error;
    }
  }

  // ------------------------------------------------------------------ years
  const listYears = (actor: Actor) => repo.listYears(actor.schoolId);

  async function getYear(actor: Actor, yearId: string): Promise<Result<YearRecord>> {
    const year = await repo.findYear(actor.schoolId, yearId);
    return year ? ok(year) : fail("not_found");
  }

  function createYear(actor: Actor, input: { name: unknown; startDate: unknown; endDate: unknown }): Promise<Result<YearRecord>> {
    return guard(async () => {
      const errors: Record<string, string> = {};
      const name = checkName(input.name, errors);
      const dates = checkDates(input.startDate, input.endDate, errors);
      if (!name || !dates) return fail("validation_error", errors);

      const years = await repo.listYears(actor.schoolId);
      if (years.some((y) => same(y.name, name))) return fail("duplicate_name", { name: "An academic year with this name already exists." });
      if (years.some((y) => rangesOverlap(y, dates))) return fail("dates_overlap", { startDate: "These dates overlap another academic year." });

      const created = await repo.createYear(actor.schoolId, { name, ...dates } satisfies NewYear);
      await audit(actor, "academic_year.created", "academic_year", created.id, { name, startDate: dates.startDate, endDate: dates.endDate });
      return ok(created);
    });
  }

  function updateYear(actor: Actor, yearId: string, patch: { name?: unknown; startDate?: unknown; endDate?: unknown }): Promise<Result<YearRecord>> {
    return guard(async () => {
      const current = await repo.findYear(actor.schoolId, yearId);
      if (!current) return fail("not_found");
      if (current.status === "CLOSED") return fail("period_closed");

      const errors: Record<string, string> = {};
      const next: YearPatch = {};
      if (patch.name !== undefined) { const n = checkName(patch.name, errors); if (n) next.name = n; }
      const merged = checkDates(patch.startDate ?? current.startDate, patch.endDate ?? current.endDate, errors);
      if (Object.keys(errors).length || !merged) return fail("validation_error", errors);
      if (patch.startDate !== undefined) next.startDate = merged.startDate;
      if (patch.endDate !== undefined) next.endDate = merged.endDate;
      if (Object.keys(next).length === 0) return fail("validation_error", { body: "Nothing to change." });

      const years = (await repo.listYears(actor.schoolId)).filter((y) => y.id !== yearId);
      if (next.name && years.some((y) => same(y.name, next.name!))) return fail("duplicate_name", { name: "An academic year with this name already exists." });
      if (years.some((y) => rangesOverlap(y, merged))) return fail("dates_overlap", { startDate: "These dates overlap another academic year." });

      const terms = await repo.listTerms(actor.schoolId, yearId);
      if (terms.some((t) => !isInside(t, merged))) return fail("terms_outside_year", { startDate: "Existing terms would fall outside these dates." });

      const updated = await repo.updateYear(actor.schoolId, yearId, next);
      if (!updated) return fail("not_found");
      await audit(actor, "academic_year.updated", "academic_year", yearId, { changed: Object.keys(next) });
      return ok(updated);
    });
  }

  function activateYear(actor: Actor, yearId: string): Promise<Result<YearRecord>> {
    return guard(async () => {
      const year = await repo.findYear(actor.schoolId, yearId);
      if (!year) return fail("not_found");
      if (year.status === "CLOSED") return fail("period_closed");
      if (year.status === "ACTIVE") return fail("already_active");
      const result = await repo.activateYear(actor.schoolId, yearId);
      if (!result) return fail("not_found");
      await audit(actor, "academic_year.activated", "academic_year", yearId, { closedPreviousYearId: result.closedYearId });
      return ok(result.year);
    });
  }

  function closeYear(actor: Actor, yearId: string): Promise<Result<YearRecord>> {
    return guard(async () => {
      const year = await repo.findYear(actor.schoolId, yearId);
      if (!year) return fail("not_found");
      if (year.status !== "ACTIVE") return fail("not_active");
      const closed = await repo.closeYear(actor.schoolId, yearId);
      if (!closed) return fail("not_found");
      await audit(actor, "academic_year.closed", "academic_year", yearId, {});
      return ok(closed);
    });
  }

  // ------------------------------------------------------------------ terms
  async function listTerms(actor: Actor, yearId: string): Promise<Result<TermRecord[]>> {
    if (!(await repo.findYear(actor.schoolId, yearId))) return fail("not_found");
    return ok(await repo.listTerms(actor.schoolId, yearId));
  }

  function createTerm(
    actor: Actor, yearId: string, input: { name: unknown; sequence?: unknown; startDate: unknown; endDate: unknown },
  ): Promise<Result<TermRecord>> {
    return guard(async () => {
      const year = await repo.findYear(actor.schoolId, yearId);
      if (!year) return fail("not_found");
      if (year.status === "CLOSED") return fail("period_closed");

      const errors: Record<string, string> = {};
      const name = checkName(input.name, errors);
      const dates = checkDates(input.startDate, input.endDate, errors);
      const siblings = await repo.listTerms(actor.schoolId, yearId);
      let sequence: number;
      if (input.sequence === undefined || input.sequence === null) sequence = siblings.reduce((m, t) => Math.max(m, t.sequence), 0) + 1;
      else if (typeof input.sequence === "number" && Number.isInteger(input.sequence) && input.sequence >= 1 && input.sequence <= 12) sequence = input.sequence;
      else { errors.sequence = "The term number must be a whole number from 1 to 12."; sequence = 0; }
      if (!name || !dates || Object.keys(errors).length) return fail("validation_error", errors);

      if (!isInside(dates, year)) return fail("outside_year", { startDate: "The term must fall inside its academic year." });
      if (siblings.some((t) => same(t.name, name))) return fail("duplicate_name", { name: "This year already has a term with this name." });
      if (siblings.some((t) => t.sequence === sequence)) return fail("duplicate_sequence", { sequence: "This year already has a term with this number." });
      if (siblings.some((t) => rangesOverlap(t, dates))) return fail("dates_overlap", { startDate: "These dates overlap another term in this year." });

      const created = await repo.createTerm(actor.schoolId, yearId, { name, sequence, ...dates } satisfies NewTerm);
      if (!created) return fail("not_found");
      await audit(actor, "term.created", "term", created.id, { academicYearId: yearId, name, sequence });
      return ok(created);
    });
  }

  function updateTerm(
    actor: Actor, yearId: string, termId: string, patch: { name?: unknown; sequence?: unknown; startDate?: unknown; endDate?: unknown },
  ): Promise<Result<TermRecord>> {
    return guard(async () => {
      const year = await repo.findYear(actor.schoolId, yearId);
      const term = year ? await repo.findTerm(actor.schoolId, yearId, termId) : null;
      if (!year || !term) return fail("not_found");
      if (term.status === "CLOSED" || year.status === "CLOSED") return fail("period_closed");

      const errors: Record<string, string> = {};
      const next: TermPatch = {};
      if (patch.name !== undefined) { const n = checkName(patch.name, errors); if (n) next.name = n; }
      if (patch.sequence !== undefined) {
        if (typeof patch.sequence === "number" && Number.isInteger(patch.sequence) && patch.sequence >= 1 && patch.sequence <= 12) next.sequence = patch.sequence;
        else errors.sequence = "The term number must be a whole number from 1 to 12.";
      }
      const merged = checkDates(patch.startDate ?? term.startDate, patch.endDate ?? term.endDate, errors);
      if (Object.keys(errors).length || !merged) return fail("validation_error", errors);
      if (patch.startDate !== undefined) next.startDate = merged.startDate;
      if (patch.endDate !== undefined) next.endDate = merged.endDate;
      if (Object.keys(next).length === 0) return fail("validation_error", { body: "Nothing to change." });

      if (!isInside(merged, year)) return fail("outside_year", { startDate: "The term must fall inside its academic year." });
      const siblings = (await repo.listTerms(actor.schoolId, yearId)).filter((t) => t.id !== termId);
      if (next.name && siblings.some((t) => same(t.name, next.name!))) return fail("duplicate_name", { name: "This year already has a term with this name." });
      if (next.sequence !== undefined && siblings.some((t) => t.sequence === next.sequence)) return fail("duplicate_sequence", { sequence: "This year already has a term with this number." });
      if (siblings.some((t) => rangesOverlap(t, merged))) return fail("dates_overlap", { startDate: "These dates overlap another term in this year." });

      const updated = await repo.updateTerm(actor.schoolId, yearId, termId, next);
      if (!updated) return fail("not_found");
      await audit(actor, "term.updated", "term", termId, { changed: Object.keys(next) });
      return ok(updated);
    });
  }

  function activateTerm(actor: Actor, yearId: string, termId: string): Promise<Result<TermRecord>> {
    return guard(async () => {
      const year = await repo.findYear(actor.schoolId, yearId);
      const term = year ? await repo.findTerm(actor.schoolId, yearId, termId) : null;
      if (!year || !term) return fail("not_found");
      if (year.status !== "ACTIVE") return fail("year_not_active");
      if (term.status === "CLOSED") return fail("period_closed");
      if (term.status === "ACTIVE") return fail("already_active");
      const result = await repo.activateTerm(actor.schoolId, yearId, termId);
      if (!result) return fail("not_found");
      await audit(actor, "term.activated", "term", termId, { closedPreviousTermId: result.closedTermId });
      return ok(result.term);
    });
  }

  function closeTerm(actor: Actor, yearId: string, termId: string): Promise<Result<TermRecord>> {
    return guard(async () => {
      const term = await repo.findTerm(actor.schoolId, yearId, termId);
      if (!term) return fail("not_found");
      if (term.status !== "ACTIVE") return fail("not_active");
      const closed = await repo.closeTerm(actor.schoolId, yearId, termId);
      if (!closed) return fail("not_found");
      await audit(actor, "term.closed", "term", termId, {});
      return ok(closed);
    });
  }

  return { listYears, getYear, createYear, updateYear, activateYear, closeYear, listTerms, createTerm, updateTerm, activateTerm, closeTerm };
}

export type AcademicService = ReturnType<typeof createAcademicService>;
