import type { PrismaClient } from "@ymt/database";
import { RepositoryConflict } from "../academic/ports.js";
import type { AuditEventInput } from "../auth/ports.js";
import type { ClassLevel, ClassPatch, ClassRecord, ClassRepository, NewClass } from "../classes/ports.js";

const toRecord = (c: { id: string; name: string; level: string; sortOrder: number; isActive: boolean }): ClassRecord => ({
  id: c.id, name: c.name, level: c.level as ClassLevel, sortOrder: c.sortOrder, isActive: c.isActive,
});

/** A unique-index violation (P2002) becomes a clean conflict; nothing from the original error is kept. */
function translate(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === "P2002") throw new RepositoryConflict("duplicate");
  throw error;
}

/** PostgreSQL-backed classes. Every query includes the school id. There is no delete. */
export function createPrismaClassRepository(db: PrismaClient): ClassRepository {
  return {
    async listClasses(schoolId) {
      const rows = await db.class.findMany({ where: { schoolId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
      return rows.map(toRecord);
    },

    async findClass(schoolId, classId) {
      const row = await db.class.findFirst({ where: { id: classId, schoolId } });
      return row ? toRecord(row) : null;
    },

    async createClass(schoolId, input: NewClass) {
      try {
        return toRecord(await db.class.create({ data: { schoolId, name: input.name, level: input.level, sortOrder: input.sortOrder } }));
      } catch (error) { return translate(error); }
    },

    async updateClass(schoolId, classId, patch: ClassPatch) {
      try {
        const result = await db.class.updateMany({
          where: { id: classId, schoolId },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.level !== undefined ? { level: patch.level } : {}),
            ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
            ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          },
        });
        if (result.count === 0) return null;
        const row = await db.class.findFirst({ where: { id: classId, schoolId } });
        return row ? toRecord(row) : null;
      } catch (error) { return translate(error); }
    },

    async reorderClasses(schoolId, orderedIds) {
      return db.$transaction(async (tx) => {
        const existing = await tx.class.findMany({ where: { schoolId }, select: { id: true } });
        const known = new Set(existing.map((c) => c.id));
        if (orderedIds.length !== existing.length || orderedIds.some((id) => !known.has(id))) return null;
        for (const [index, id] of orderedIds.entries()) {
          await tx.class.updateMany({ where: { id, schoolId }, data: { sortOrder: index + 1 } });
        }
        const rows = await tx.class.findMany({ where: { schoolId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
        return rows.map(toRecord);
      });
    },

    async appendAudit(event: AuditEventInput) {
      await db.auditEvent.create({
        data: {
          schoolId: event.schoolId, actorUserId: event.actorUserId, action: event.action,
          entityType: event.entityType, entityId: event.entityId, metadata: event.metadata as object,
        },
      });
    },
  };
}
