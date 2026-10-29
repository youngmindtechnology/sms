import { RepositoryConflict } from "../academic/ports.js";
import { fail, makeAudit, ok, redactGuardian, type Actor, type Result } from "./common.js";
import type { GuardianLink, GuardianPatch, GuardianRecord, GuardianRelationship, LinkPatch, LinkRecord, NewGuardian, StudentRepository, StudentSummary } from "./ports.js";
import { cleanEmail, cleanPhone, cleanText, isRelationship } from "./validation.js";

const RELATIONSHIP_MESSAGE = "Choose a relationship from the list.";

/** Reads and validates guardian details. Only a name, a phone number and an e-mail address are kept. */
function readGuardian(input: { fullName?: unknown; phone?: unknown; email?: unknown }, errors: Record<string, string>): NewGuardian | null {
  const fullName = cleanText(input.fullName, "fullName", "the guardian's full name", 200, errors);
  const phone = cleanPhone(input.phone, errors);
  const email = cleanEmail(input.email, errors);
  if (!fullName || Object.keys(errors).length) return null;
  if (!phone && !email) { errors.phone = "Enter a phone number or an email address so the school can reach this guardian."; return null; }
  return { fullName, phone: phone ?? null, email: email ?? null };
}

export interface GuardianDetail { guardian: GuardianRecord; students: Array<StudentSummary & { relationship: GuardianRelationship; isPrimaryContact: boolean }> }

export function createGuardianService(repo: StudentRepository) {
  async function guard<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RepositoryConflict) {
        // "overlap" here means another request just made a different guardian the primary contact.
        return fail("already_linked", error.kind === "overlap"
          ? { isPrimaryContact: "The primary guardian was just changed by someone else. Reload and try again." }
          : { guardianId: "This guardian is already linked to this student." });
      }
      throw error;
    }
  }

  async function search(actor: Actor, term: unknown): Promise<Result<GuardianRecord[]>> {
    if (typeof term !== "string" || term.trim().length < 2 || term.length > 100) return fail("validation_error", { search: "Type at least 2 characters to search (at most 100)." });
    // Phone numbers are stored as +233..., so a typed local number (024...) is searched in that form.
    const typed = term.trim();
    const compact = typed.replace(/[\s().-]/g, "");
    const searchTerm = /^0\d{3,9}$/.test(compact) ? `+233${compact.slice(1)}` : typed;
    return ok((await repo.searchGuardians(actor.schoolId, searchTerm, 20)).map((g) => redactGuardian(g, actor)));
  }

  async function detail(actor: Actor, guardianId: string): Promise<Result<GuardianDetail>> {
    const guardian = await repo.findGuardian(actor.schoolId, guardianId);
    if (!guardian) return fail("not_found");
    return ok({ guardian: redactGuardian(guardian, actor), students: await repo.listLinkedStudents(actor.schoolId, guardianId) });
  }

  async function update(actor: Actor, guardianId: string, patch: { fullName?: unknown; phone?: unknown; email?: unknown }): Promise<Result<GuardianRecord>> {
    const current = await repo.findGuardian(actor.schoolId, guardianId);
    if (!current) return fail("not_found");

    const errors: Record<string, string> = {};
    const next: GuardianPatch = {};
    if (patch.fullName !== undefined) { const v = cleanText(patch.fullName, "fullName", "the guardian's full name", 200, errors); if (v) next.fullName = v; }
    if (patch.phone !== undefined) { const v = cleanPhone(patch.phone, errors); if (v !== undefined) next.phone = v; }
    if (patch.email !== undefined) { const v = cleanEmail(patch.email, errors); if (v !== undefined) next.email = v; }
    if (Object.keys(errors).length) return fail("validation_error", errors);
    if (Object.keys(next).length === 0) return fail("validation_error", { body: "Nothing to change." });
    const phone = next.phone !== undefined ? next.phone : current.phone;
    const email = next.email !== undefined ? next.email : current.email;
    if (!phone && !email) return fail("validation_error", { phone: "Keep a phone number or an email address so the school can reach this guardian." });

    const updated = await repo.updateGuardian(actor.schoolId, guardianId, next);
    if (!updated) return fail("not_found");
    await makeAudit(repo, actor)("guardian.updated", "guardian", guardianId, { changed: Object.keys(next) });
    return ok(redactGuardian(updated, actor));
  }

  /**
   * Links an existing guardian (`guardianId`) or creates a new one and links it (`guardian`), in one
   * atomic step. The first guardian of a student becomes the primary contact unless told otherwise.
   * Siblings share one guardian record: link the same guardian to each child.
   */
  function link(
    actor: Actor, studentId: string,
    input: { guardianId?: unknown; guardian?: { fullName?: unknown; phone?: unknown; email?: unknown }; relationship?: unknown; isPrimaryContact?: unknown },
  ): Promise<Result<{ guardian: GuardianRecord; link: LinkRecord }>> {
    return guard(async () => {
      const student = await repo.findStudent(actor.schoolId, studentId);
      if (!student) return fail("not_found");

      const errors: Record<string, string> = {};
      if (!isRelationship(input.relationship)) errors.relationship = RELATIONSHIP_MESSAGE;
      if (input.isPrimaryContact !== undefined && typeof input.isPrimaryContact !== "boolean") errors.isPrimaryContact = "Primary contact must be true or false.";
      const hasId = input.guardianId !== undefined;
      const hasNew = input.guardian !== undefined;
      if (hasId === hasNew) errors.guardian = "Choose an existing guardian or enter a new one.";
      if (Object.keys(errors).length) return fail("validation_error", errors);

      const existingLinks = await repo.listGuardianLinks(actor.schoolId, studentId);
      const primary = typeof input.isPrimaryContact === "boolean" ? input.isPrimaryContact : existingLinks.length === 0;
      const relationship = input.relationship as GuardianRelationship;
      const audit = makeAudit(repo, actor);

      if (hasId) {
        if (typeof input.guardianId !== "string") return fail("validation_error", { guardianId: "Choose a guardian." });
        // A guardian from another school looks exactly like a missing one.
        const guardian = await repo.findGuardian(actor.schoolId, input.guardianId);
        if (!guardian) return fail("validation_error", { guardianId: "Choose a guardian from your school." });
        if (existingLinks.some((l) => l.id === guardian.id)) return fail("already_linked", { guardianId: "This guardian is already linked to this student." });
        const linked = await repo.linkGuardian(actor.schoolId, studentId, guardian.id, relationship, primary);
        if (!linked) return fail("not_found");
        await audit("student.guardian_linked", "student", studentId, { guardianId: guardian.id, relationship, isPrimaryContact: primary });
        return ok({ guardian: redactGuardian(guardian, actor), link: linked });
      }

      const details = readGuardian(input.guardian ?? {}, errors);
      if (!details) return fail("validation_error", Object.fromEntries(Object.entries(errors).map(([k, v]) => [`guardian.${k}`, v])));
      const created = await repo.createGuardianAndLink(actor.schoolId, studentId, details, relationship, primary);
      if (!created) return fail("not_found");
      await audit("guardian.created", "guardian", created.guardian.id, {});
      await audit("student.guardian_linked", "student", studentId, { guardianId: created.guardian.id, relationship, isPrimaryContact: primary });
      return ok({ ...created, guardian: redactGuardian(created.guardian, actor) });
    });
  }

  async function updateLink(actor: Actor, studentId: string, guardianId: string, patch: { relationship?: unknown; isPrimaryContact?: unknown }): Promise<Result<LinkRecord>> {
    const errors: Record<string, string> = {};
    const next: LinkPatch = {};
    if (patch.relationship !== undefined) { if (isRelationship(patch.relationship)) next.relationship = patch.relationship; else errors.relationship = RELATIONSHIP_MESSAGE; }
    if (patch.isPrimaryContact !== undefined) { if (typeof patch.isPrimaryContact === "boolean") next.isPrimaryContact = patch.isPrimaryContact; else errors.isPrimaryContact = "Primary contact must be true or false."; }
    const current = await repo.findLink(actor.schoolId, studentId, guardianId);
    if (!current) return fail("not_found");
    if (Object.keys(errors).length) return fail("validation_error", errors);
    if (Object.keys(next).length === 0) return fail("validation_error", { body: "Nothing to change." });

    const updated = await repo.updateLink(actor.schoolId, studentId, guardianId, next);
    if (!updated) return fail("not_found");
    await makeAudit(repo, actor)("student.guardian_updated", "student", studentId, { guardianId, changed: Object.keys(next), ...next });
    return ok(updated);
  }

  /** Removes the link only. The guardian record stays (it may belong to a sibling) and the audit trail records what was removed. */
  async function unlink(actor: Actor, studentId: string, guardianId: string): Promise<Result<{ removed: true }>> {
    const current = await repo.findLink(actor.schoolId, studentId, guardianId);
    if (!current) return fail("not_found");
    if (!(await repo.unlinkGuardian(actor.schoolId, studentId, guardianId))) return fail("not_found");
    await makeAudit(repo, actor)("student.guardian_unlinked", "student", studentId, { guardianId, relationship: current.relationship, wasPrimaryContact: current.isPrimaryContact });
    return ok({ removed: true });
  }

  return { search, detail, update, link, updateLink, unlink };
}

export type GuardianService = ReturnType<typeof createGuardianService>;
export type { GuardianLink };
