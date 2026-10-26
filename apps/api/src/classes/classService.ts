import { RepositoryConflict } from "../academic/ports.js";
import { assertAuditSafe } from "../auth/audit.js";
import { CLASS_LEVELS, type ClassLevel, type ClassPatch, type ClassRecord, type ClassRepository } from "./ports.js";

export interface Actor { schoolId: string; userId: string }

export type ClassErrorCode = "validation_error" | "not_found" | "duplicate_name" | "order_mismatch";
export type Result<T> = { ok: true; value: T } | { ok: false; error: ClassErrorCode; fields?: Record<string, string> };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: ClassErrorCode, fields?: Record<string, string>): Result<never> => ({ ok: false, error, fields });
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const MAX_SORT_ORDER = 10_000;

/** Trim and squeeze inner spaces, so "Basic  1A " and "Basic 1A" are the same class. */
function checkName(value: unknown, errors: Record<string, string>): string | null {
  if (typeof value !== "string") { errors.name = "Enter a name."; return null; }
  const name = value.trim().replace(/\s+/g, " ");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) { errors.name = "The name contains characters that aren't allowed."; return null; }
  if (name.length < 1 || name.length > 100) { errors.name = "The name must be 1 to 100 characters."; return null; }
  return name;
}

const isLevel = (value: unknown): value is ClassLevel => typeof value === "string" && (CLASS_LEVELS as readonly string[]).includes(value);
const isOrder = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_SORT_ORDER;

export function createClassService(repo: ClassRepository) {
  async function audit(actor: Actor, action: string, entityId: string | null, metadata: Record<string, unknown>) {
    assertAuditSafe(metadata);
    await repo.appendAudit({ schoolId: actor.schoolId, actorUserId: actor.userId, action, entityType: "class", entityId, metadata });
  }

  async function guard<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RepositoryConflict) return fail("duplicate_name", { name: "A class with this name already exists." });
      throw error;
    }
  }

  const listClasses = (actor: Actor) => repo.listClasses(actor.schoolId);

  function createClass(actor: Actor, input: { name: unknown; level: unknown; sortOrder?: unknown }): Promise<Result<ClassRecord>> {
    return guard(async () => {
      const errors: Record<string, string> = {};
      const name = checkName(input.name, errors);
      if (!isLevel(input.level)) errors.level = "Choose Nursery, KG, Primary or JHS.";
      if (input.sortOrder !== undefined && !isOrder(input.sortOrder)) errors.sortOrder = `The order must be a whole number from 0 to ${MAX_SORT_ORDER}.`;
      if (!name || Object.keys(errors).length) return fail("validation_error", errors);

      const existing = await repo.listClasses(actor.schoolId);
      if (existing.some((c) => same(c.name, name))) return fail("duplicate_name", { name: "A class with this name already exists." });
      const sortOrder = input.sortOrder === undefined ? existing.reduce((m, c) => Math.max(m, c.sortOrder), 0) + 1 : (input.sortOrder as number);

      const created = await repo.createClass(actor.schoolId, { name, level: input.level as ClassLevel, sortOrder });
      await audit(actor, "class.created", created.id, { name, level: created.level });
      return ok(created);
    });
  }

  function updateClass(
    actor: Actor, classId: string, patch: { name?: unknown; level?: unknown; sortOrder?: unknown; isActive?: unknown },
  ): Promise<Result<ClassRecord>> {
    return guard(async () => {
      const current = await repo.findClass(actor.schoolId, classId);
      if (!current) return fail("not_found");

      const errors: Record<string, string> = {};
      const next: ClassPatch = {};
      if (patch.name !== undefined) { const n = checkName(patch.name, errors); if (n) next.name = n; }
      if (patch.level !== undefined) { if (isLevel(patch.level)) next.level = patch.level; else errors.level = "Choose Nursery, KG, Primary or JHS."; }
      if (patch.sortOrder !== undefined) { if (isOrder(patch.sortOrder)) next.sortOrder = patch.sortOrder; else errors.sortOrder = `The order must be a whole number from 0 to ${MAX_SORT_ORDER}.`; }
      if (patch.isActive !== undefined) { if (typeof patch.isActive === "boolean") next.isActive = patch.isActive; else errors.isActive = "Active must be true or false."; }
      if (Object.keys(errors).length) return fail("validation_error", errors);
      if (Object.keys(next).length === 0) return fail("validation_error", { body: "Nothing to change." });

      if (next.name) {
        const others = (await repo.listClasses(actor.schoolId)).filter((c) => c.id !== classId);
        if (others.some((c) => same(c.name, next.name!))) return fail("duplicate_name", { name: "A class with this name already exists." });
      }

      const updated = await repo.updateClass(actor.schoolId, classId, next);
      if (!updated) return fail("not_found");
      await audit(actor, next.isActive === undefined || Object.keys(next).length > 1 ? "class.updated" : next.isActive ? "class.activated" : "class.deactivated", classId, {
        changed: Object.keys(next),
        ...(next.isActive !== undefined ? { isActive: next.isActive } : {}),
      });
      return ok(updated);
    });
  }

  /** The list must be exactly the school's classes, each once; a stale screen gets a conflict, not a silent overwrite. */
  function reorderClasses(actor: Actor, classIds: unknown): Promise<Result<ClassRecord[]>> {
    return guard(async () => {
      if (!Array.isArray(classIds) || classIds.some((id) => typeof id !== "string")) return fail("validation_error", { classIds: "Send the list of class ids in the new order." });
      const ids = classIds as string[];
      if (new Set(ids).size !== ids.length) return fail("validation_error", { classIds: "Each class may appear only once." });

      const existing = await repo.listClasses(actor.schoolId);
      const known = new Set(existing.map((c) => c.id));
      if (ids.length !== existing.length || ids.some((id) => !known.has(id))) return fail("order_mismatch");

      const result = await repo.reorderClasses(actor.schoolId, ids);
      if (!result) return fail("order_mismatch");
      await audit(actor, "class.reordered", null, { count: ids.length });
      return ok(result);
    });
  }

  return { listClasses, createClass, updateClass, reorderClasses };
}

export type ClassService = ReturnType<typeof createClassService>;
