import { randomUUID } from "node:crypto";
import { RepositoryConflict } from "../academic/ports.js";
import type { AuditEventInput } from "../auth/ports.js";
import type { ClassPatch, ClassRecord, ClassRepository, NewClass } from "../classes/ports.js";

type Row = ClassRecord & { schoolId: string };

/** In-memory stand-in for the database (tests only). Enforces the same unique name per school. */
export class MemoryClassRepository implements ClassRepository {
  rows: Row[] = [];
  audit: AuditEventInput[] = [];
  /** Test hook: fail part-way through a reorder to prove nothing is half-saved. */
  failNextReorder = false;

  private strip(row: Row): ClassRecord { const { schoolId: _s, ...rest } = row; return rest; }
  private mine(schoolId: string) { return this.rows.filter((r) => r.schoolId === schoolId); }

  async listClasses(schoolId: string) {
    return this.mine(schoolId).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map((r) => this.strip(r));
  }
  async findClass(schoolId: string, id: string) { const r = this.mine(schoolId).find((x) => x.id === id); return r ? this.strip(r) : null; }

  async createClass(schoolId: string, input: NewClass) {
    if (this.mine(schoolId).some((r) => r.name === input.name)) throw new RepositoryConflict("duplicate");
    const row: Row = { id: randomUUID(), schoolId, isActive: true, ...input };
    this.rows.push(row);
    return this.strip(row);
  }

  async updateClass(schoolId: string, id: string, patch: ClassPatch) {
    const row = this.mine(schoolId).find((x) => x.id === id);
    if (!row) return null;
    if (patch.name && this.mine(schoolId).some((r) => r.id !== id && r.name === patch.name)) throw new RepositoryConflict("duplicate");
    Object.assign(row, patch);
    return this.strip(row);
  }

  async reorderClasses(schoolId: string, orderedIds: string[]) {
    const mine = this.mine(schoolId);
    if (orderedIds.length !== mine.length || orderedIds.some((id) => !mine.some((r) => r.id === id))) return null;
    const before = mine.map((r) => r.sortOrder);
    try {
      orderedIds.forEach((id, index) => {
        mine.find((r) => r.id === id)!.sortOrder = index + 1;
        if (this.failNextReorder && index === 1) { this.failNextReorder = false; throw new Error("simulated database failure"); }
      });
    } catch (error) {
      mine.forEach((r, i) => { r.sortOrder = before[i]!; });
      throw error;
    }
    return this.listClasses(schoolId);
  }

  async appendAudit(event: AuditEventInput) { this.audit.push(event); }
}
