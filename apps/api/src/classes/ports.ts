import type { AuditEventInput } from "../auth/ports.js";

/** Stored values. The screen shows KINDERGARTEN as "KG". */
export const CLASS_LEVELS = ["NURSERY", "KINDERGARTEN", "PRIMARY", "JHS"] as const;
export type ClassLevel = (typeof CLASS_LEVELS)[number];

export interface ClassRecord {
  id: string;
  name: string;
  level: ClassLevel;
  sortOrder: number;
  isActive: boolean;
}

export interface NewClass { name: string; level: ClassLevel; sortOrder: number }
export interface ClassPatch { name?: string; level?: ClassLevel; sortOrder?: number; isActive?: boolean }

/**
 * Every method takes the school id FIRST and applies it to every query; the id always comes
 * from the verified session. A class in another school is indistinguishable from a missing
 * one (null). There is deliberately no delete: classes are history for enrollments.
 */
export interface ClassRepository {
  /** Ordered by sort order, then name. Includes inactive classes. */
  listClasses(schoolId: string): Promise<ClassRecord[]>;
  findClass(schoolId: string, classId: string): Promise<ClassRecord | null>;
  createClass(schoolId: string, input: NewClass): Promise<ClassRecord>;
  updateClass(schoolId: string, classId: string, patch: ClassPatch): Promise<ClassRecord | null>;
  /**
   * Atomically gives the classes sort orders 1..n in the given order. Returns null (changing
   * nothing) if the list is not exactly the school's classes.
   */
  reorderClasses(schoolId: string, orderedIds: string[]): Promise<ClassRecord[] | null>;
  appendAudit(event: AuditEventInput): Promise<void>;
}
