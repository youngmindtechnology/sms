import { randomUUID } from "node:crypto";
import type { AuditEventInput } from "../auth/ports.js";
import {
  SubjectConflict,
  type AssignmentRecord, type AssignmentStatus, type AuditDraft, type ClassRef, type EligibleTeacher, type NewSubject,
  type SubjectPatch, type SubjectRecord, type SubjectRepository, type YearRef,
} from "../subjects/ports.js";
import type { MemoryRepository } from "./memoryRepository.js";

type SubjectRow = SubjectRecord & { schoolId: string };
type AssignmentRow = { id: string; schoolId: string; subjectId: string; academicYearId: string; userId: string; status: AssignmentStatus; endedAt: string | null; createdAt: string };

const lower = (s: string) => s.toLowerCase();

/**
 * In-memory stand-in for the database (tests only). It works on the SAME users and memberships as the
 * authentication fake, so suspending or ending a teacher is seen here at once. It enforces the same
 * rules as the database: unique name (any case) and code per class, one ACTIVE assignment per
 * subject + year + teacher, and the school scoping of every record.
 */
export class MemorySubjectRepository implements SubjectRepository {
  classes: Array<ClassRef & { schoolId: string }> = [];
  years: Array<YearRef & { schoolId: string }> = [];
  subjects: SubjectRow[] = [];
  assignments: AssignmentRow[] = [];
  audit: AuditEventInput[] = [];
  /** Test hooks: fail part-way through a write to prove nothing is half-saved. */
  failNextReplace = false;
  failNextCreate = false;

  constructor(private readonly auth: MemoryRepository, private readonly clock: () => Date = () => new Date()) {}

  seedClass(schoolId: string, name: string, isActive = true): ClassRef {
    const row = { id: randomUUID(), schoolId, name, isActive };
    this.classes.push(row);
    return { id: row.id, name, isActive };
  }
  seedYear(schoolId: string, name: string, status: YearRef["status"] = "ACTIVE"): YearRef {
    const row = { id: randomUUID(), schoolId, name, status };
    this.years.push(row);
    return { id: row.id, name, status };
  }

  private strip(row: SubjectRow): SubjectRecord { const { schoolId: _s, ...rest } = row; return rest; }

  async findClass(schoolId: string, id: string) {
    const c = this.classes.find((x) => x.schoolId === schoolId && x.id === id);
    return c ? { id: c.id, name: c.name, isActive: c.isActive } : null;
  }
  async findYear(schoolId: string, id: string) {
    const y = this.years.find((x) => x.schoolId === schoolId && x.id === id);
    return y ? { id: y.id, name: y.name, status: y.status } : null;
  }

  async listSubjects(schoolId: string, classId: string) {
    return this.subjects.filter((s) => s.schoolId === schoolId && s.classId === classId).sort((a, b) => a.name.localeCompare(b.name)).map((s) => this.strip(s));
  }
  async findSubject(schoolId: string, id: string) {
    const s = this.subjects.find((x) => x.schoolId === schoolId && x.id === id);
    return s ? this.strip(s) : null;
  }

  private checkUnique(schoolId: string, classId: string, exceptId: string | null, name: string | undefined, code: string | null | undefined) {
    const others = this.subjects.filter((s) => s.schoolId === schoolId && s.classId === classId && s.id !== exceptId);
    if (name !== undefined && others.some((s) => lower(s.name) === lower(name))) throw new SubjectConflict("name");
    if (code && others.some((s) => s.code === code)) throw new SubjectConflict("code");
  }

  async createSubject(schoolId: string, input: NewSubject) {
    if (!this.classes.some((c) => c.schoolId === schoolId && c.id === input.classId)) throw new SubjectConflict("state");
    this.checkUnique(schoolId, input.classId, null, input.name, input.code);
    const row: SubjectRow = { id: randomUUID(), schoolId, classId: input.classId, name: input.name, code: input.code, isActive: true };
    this.subjects.push(row);
    return this.strip(row);
  }

  async updateSubject(schoolId: string, id: string, patch: SubjectPatch) {
    const row = this.subjects.find((x) => x.schoolId === schoolId && x.id === id);
    if (!row) return null;
    this.checkUnique(schoolId, row.classId, id, patch.name, patch.code);
    Object.assign(row, patch);
    return this.strip(row);
  }

  async appendAudit(event: AuditEventInput) { this.audit.push(event); }

  // ----- teachers -----
  private memberships(schoolId: string) {
    const out: Array<{ userId: string; membershipId: string; status: string; roles: string[] }> = [];
    for (const [userId, list] of this.auth.memberships) for (const m of list) if (m.schoolId === schoolId) out.push({ userId, membershipId: m.membershipId, status: m.status, roles: m.roles });
    return out;
  }
  private isEligible(schoolId: string, m: { userId: string; status: string; roles: string[] }) {
    return m.status === "ACTIVE" && this.auth.users.get(m.userId)?.status === "ACTIVE" && m.roles.includes("TEACHER");
  }
  async findTeacher(schoolId: string, membershipId: string) {
    const m = this.memberships(schoolId).find((x) => x.membershipId === membershipId);
    if (!m) return null;
    return { membershipId, fullName: this.auth.users.get(m.userId)!.fullName, eligible: this.isEligible(schoolId, m) };
  }
  async listEligibleTeachers(schoolId: string): Promise<EligibleTeacher[]> {
    return this.memberships(schoolId).filter((m) => this.isEligible(schoolId, m))
      .map((m) => ({ membershipId: m.membershipId, fullName: this.auth.users.get(m.userId)!.fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  // ----- assignments -----
  private view(row: AssignmentRow): AssignmentRecord {
    const m = this.memberships(row.schoolId).find((x) => x.userId === row.userId)!;
    return {
      id: row.id, subjectId: row.subjectId, academicYearId: row.academicYearId,
      academicYearName: this.years.find((y) => y.id === row.academicYearId)?.name ?? "",
      teacherMembershipId: m.membershipId, teacherName: this.auth.users.get(row.userId)!.fullName,
      status: row.status, endedAt: row.endedAt, createdAt: row.createdAt,
    };
  }
  private userOf(schoolId: string, membershipId: string) { return this.memberships(schoolId).find((m) => m.membershipId === membershipId) ?? null; }

  async listActiveAssignmentsForClass(schoolId: string, classId: string, academicYearId: string) {
    const ids = new Set(this.subjects.filter((s) => s.schoolId === schoolId && s.classId === classId).map((s) => s.id));
    return this.assignments
      .filter((a) => a.schoolId === schoolId && a.academicYearId === academicYearId && a.status === "ACTIVE" && ids.has(a.subjectId))
      .map((a) => this.view(a)).sort((x, y) => x.teacherName.localeCompare(y.teacherName));
  }
  async listAssignments(schoolId: string, subjectId: string, opts: { academicYearId?: string; includeEnded: boolean }) {
    return this.assignments
      .filter((a) => a.schoolId === schoolId && a.subjectId === subjectId && (opts.academicYearId === undefined || a.academicYearId === opts.academicYearId) && (opts.includeEnded || a.status === "ACTIVE"))
      .map((a) => this.view(a)).sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.teacherName.localeCompare(y.teacherName));
  }
  async findAssignment(schoolId: string, id: string) {
    const a = this.assignments.find((x) => x.schoolId === schoolId && x.id === id);
    return a ? this.view(a) : null;
  }

  /** The same re-checks the database repository makes inside its transaction. */
  private recheck(schoolId: string, subjectId: string, yearId: string, membershipId: string) {
    const subject = this.subjects.find((s) => s.schoolId === schoolId && s.id === subjectId);
    const year = this.years.find((y) => y.schoolId === schoolId && y.id === yearId);
    if (!subject || !subject.isActive || !year || year.status === "CLOSED") throw new SubjectConflict("state");
    const m = this.userOf(schoolId, membershipId);
    if (!m || !this.isEligible(schoolId, m)) throw new SubjectConflict("teacher");
    return m;
  }
  private insert(schoolId: string, subjectId: string, yearId: string, userId: string): AssignmentRow {
    if (this.assignments.some((a) => a.subjectId === subjectId && a.academicYearId === yearId && a.userId === userId && a.status === "ACTIVE")) throw new SubjectConflict("assignment");
    const row: AssignmentRow = { id: randomUUID(), schoolId, subjectId, academicYearId: yearId, userId, status: "ACTIVE", endedAt: null, createdAt: this.clock().toISOString() };
    this.assignments.push(row);
    return row;
  }
  private writeAudit(schoolId: string, audit: AuditDraft, entityId: string) {
    this.audit.push({ schoolId, actorUserId: audit.actorUserId, action: audit.action, entityType: "teaching_assignment", entityId, metadata: audit.metadata });
  }

  async createAssignment(schoolId: string, input: { subjectId: string; academicYearId: string; teacherMembershipId: string }, audit: AuditDraft) {
    const snapshot = { assignments: this.assignments.map((a) => ({ ...a })), audit: this.audit.slice() };
    try {
      const m = this.recheck(schoolId, input.subjectId, input.academicYearId, input.teacherMembershipId);
      const row = this.insert(schoolId, input.subjectId, input.academicYearId, m.userId);
      if (this.failNextCreate) { this.failNextCreate = false; throw new Error("simulated database failure"); }
      this.writeAudit(schoolId, audit, row.id);
      return this.view(row);
    } catch (error) {
      this.assignments = snapshot.assignments; this.audit = snapshot.audit;
      throw error;
    }
  }

  async replaceAssignment(schoolId: string, assignmentId: string, teacherMembershipId: string, at: Date, audit: AuditDraft) {
    const old = this.assignments.find((a) => a.schoolId === schoolId && a.id === assignmentId);
    if (!old) return null;
    const snapshot = { assignments: this.assignments.map((a) => ({ ...a })), audit: this.audit.slice() };
    try {
      if (old.status !== "ACTIVE") throw new SubjectConflict("stale");
      const m = this.recheck(schoolId, old.subjectId, old.academicYearId, teacherMembershipId);
      old.status = "ENDED"; old.endedAt = at.toISOString();
      if (this.failNextReplace) { this.failNextReplace = false; throw new Error("simulated database failure"); }
      const created = this.insert(schoolId, old.subjectId, old.academicYearId, m.userId);
      this.writeAudit(schoolId, audit, created.id);
      return { ended: this.view(old), created: this.view(created) };
    } catch (error) {
      this.assignments = snapshot.assignments; this.audit = snapshot.audit;
      throw error;
    }
  }

  async endAssignment(schoolId: string, assignmentId: string, at: Date, audit: AuditDraft) {
    const row = this.assignments.find((a) => a.schoolId === schoolId && a.id === assignmentId);
    if (!row) return null;
    if (row.status !== "ACTIVE") throw new SubjectConflict("stale");
    row.status = "ENDED"; row.endedAt = at.toISOString();
    this.writeAudit(schoolId, audit, row.id);
    return this.view(row);
  }
}
