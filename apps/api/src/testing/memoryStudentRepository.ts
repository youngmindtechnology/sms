import { randomUUID } from "node:crypto";
import { RepositoryConflict } from "../academic/ports.js";
import type { AuditEventInput } from "../auth/ports.js";
import type {
  ClassRef, EnrollmentRecord, EnrollmentStatus, GuardianLink, GuardianPatch, GuardianRecord, GuardianRelationship, LinkPatch, LinkRecord,
  NewEnrollment, NewGuardian, NewStudent, RosterEntry, StudentListItem, StudentPatch, StudentQuery, StudentRecord, StudentRepository,
  StudentStatus, StudentSummary, YearRef,
} from "../students/ports.js";

type StudentRow = StudentRecord & { schoolId: string };
type GuardianRow = GuardianRecord & { schoolId: string };
type LinkRow = LinkRecord & { schoolId: string };
type EnrollmentRow = Omit<EnrollmentRecord, "className" | "academicYearName"> & { schoolId: string };
type ClassRow = ClassRef & { schoolId: string };
type YearRow = YearRef & { schoolId: string };

const summary = (s: StudentRecord): StudentSummary => ({
  id: s.id, admissionNumber: s.admissionNumber, firstName: s.firstName, middleName: s.middleName, lastName: s.lastName, status: s.status,
});
const byName = (a: StudentRecord, b: StudentRecord) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName) || a.id.localeCompare(b.id);

/**
 * In-memory stand-in for the database (tests only). It enforces the same rules the database does:
 * unique admission number per school, one link per student and guardian, at most one primary
 * guardian per student, and no overlapping enrollments for one student.
 */
export class MemoryStudentRepository implements StudentRepository {
  students: StudentRow[] = [];
  guardians: GuardianRow[] = [];
  links: LinkRow[] = [];
  enrollments: EnrollmentRow[] = [];
  classes: ClassRow[] = [];
  years: YearRow[] = [];
  audit: AuditEventInput[] = [];
  /** Test hooks: fail part-way through a multi-step write, to prove nothing is left half-saved. */
  failNextTransfer = false;
  /** Runs at the start of a class change, to simulate another request changing the enrollment first. */
  beforeTransfer: (() => void) | null = null;
  failNextStatusChange = false;
  failNextGuardianCreate = false;

  // ----- test seeding -----
  seedClass(schoolId: string, name: string, isActive = true): ClassRef { const row = { id: randomUUID(), schoolId, name, isActive }; this.classes.push(row); return row; }
  seedYear(schoolId: string, input: Omit<YearRef, "id"> & { id?: string }): YearRef { const row = { ...input, id: input.id ?? randomUUID(), schoolId }; this.years.push(row); return row; }

  private mine<T extends { schoolId: string }>(rows: T[], schoolId: string) { return rows.filter((r) => r.schoolId === schoolId); }
  private strip<T extends { schoolId: string }>(row: T): Omit<T, "schoolId"> { const { schoolId: _s, ...rest } = row; return rest; }
  private student(schoolId: string, id: string) { return this.students.find((s) => s.schoolId === schoolId && s.id === id) ?? null; }
  private placement(schoolId: string, studentId: string) {
    const open = this.enrollments.filter((e) => e.schoolId === schoolId && e.studentId === studentId && e.status === "ENROLLED").sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
    if (!open) return null;
    return { enrollmentId: open.id, classId: open.classId, className: this.classes.find((c) => c.id === open.classId)?.name ?? "", academicYearId: open.academicYearId, academicYearName: this.years.find((y) => y.id === open.academicYearId)?.name ?? "" };
  }
  private view(row: EnrollmentRow): EnrollmentRecord {
    return { ...this.strip(row), className: this.classes.find((c) => c.id === row.classId)?.name ?? "", academicYearName: this.years.find((y) => y.id === row.academicYearId)?.name ?? "" };
  }
  private checkOverlap(schoolId: string, studentId: string, start: string, end: string | null, ignoreId?: string) {
    const clash = this.enrollments.some((e) => e.schoolId === schoolId && e.studentId === studentId && e.id !== ignoreId
      && e.startDate <= (end ?? "9999-12-31") && start <= (e.endDate ?? "9999-12-31"));
    if (clash) throw new RepositoryConflict("overlap");
  }
  private demoteOthers(schoolId: string, studentId: string, keepGuardianId: string) {
    for (const l of this.links) if (l.schoolId === schoolId && l.studentId === studentId && l.guardianId !== keepGuardianId) l.isPrimaryContact = false;
  }

  // ----- students -----
  async listStudents(schoolId: string, q: StudentQuery) {
    let rows = this.mine(this.students, schoolId);
    if (q.status) rows = rows.filter((s) => s.status === q.status);
    if (q.classId) rows = rows.filter((s) => this.placement(schoolId, s.id)?.classId === q.classId);
    if (q.nameTerms.length || q.admissionText) {
      rows = rows.filter((s) => {
        const names = [s.firstName, s.middleName ?? "", s.lastName].map((n) => n.toLowerCase());
        const nameMatch = q.nameTerms.length > 0 && q.nameTerms.every((t) => names.some((n) => n.includes(t)));
        const admMatch = q.admissionText !== null && s.admissionNumber.includes(q.admissionText);
        return nameMatch || admMatch;
      });
    }
    rows = [...rows].sort(byName);
    const items: StudentListItem[] = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((s) => ({ ...summary(s), current: this.placement(schoolId, s.id) }));
    return { items, total: rows.length };
  }
  async countStudents(schoolId: string) { return this.mine(this.students, schoolId).length; }
  async findStudent(schoolId: string, id: string) { const s = this.student(schoolId, id); return s ? this.strip(s) : null; }

  async createStudent(schoolId: string, input: NewStudent) {
    if (this.students.some((s) => s.schoolId === schoolId && s.admissionNumber === input.admissionNumber)) throw new RepositoryConflict("duplicate");
    const row: StudentRow = { id: randomUUID(), schoolId, status: "ACTIVE", ...input };
    this.students.push(row);
    return this.strip(row);
  }
  async updateStudent(schoolId: string, id: string, patch: StudentPatch) {
    const row = this.student(schoolId, id);
    if (!row) return null;
    if (patch.admissionNumber && this.students.some((s) => s.schoolId === schoolId && s.id !== id && s.admissionNumber === patch.admissionNumber)) throw new RepositoryConflict("duplicate");
    Object.assign(row, patch);
    return this.strip(row);
  }
  async setStudentStatus(schoolId: string, id: string, status: StudentStatus, close: { status: EnrollmentStatus; effectiveDate: string } | null) {
    const row = this.student(schoolId, id);
    if (!row) return null;
    const snapshot = { status: row.status, enrollments: this.enrollments.map((e) => ({ ...e })) };
    try {
      row.status = status;
      const closed: string[] = [];
      if (close) {
        for (const e of this.enrollments.filter((x) => x.schoolId === schoolId && x.studentId === id && x.status === "ENROLLED")) {
          e.status = close.status;
          e.endDate = e.endDate !== null && e.endDate < close.effectiveDate ? e.endDate : close.effectiveDate;
          closed.push(e.id);
          if (this.failNextStatusChange) { this.failNextStatusChange = false; throw new Error("simulated database failure"); }
        }
      }
      return { student: this.strip(row), closedEnrollmentIds: closed };
    } catch (error) {
      row.status = snapshot.status;
      this.enrollments = snapshot.enrollments;
      throw error;
    }
  }

  // ----- guardians -----
  async findGuardian(schoolId: string, id: string) { const g = this.guardians.find((x) => x.schoolId === schoolId && x.id === id); return g ? this.strip(g) : null; }
  async searchGuardians(schoolId: string, term: string, limit: number) {
    const t = term.toLowerCase();
    return this.mine(this.guardians, schoolId).filter((g) => g.fullName.toLowerCase().includes(t) || (g.phone ?? "").includes(term)).slice(0, limit).map((g) => this.strip(g));
  }
  async updateGuardian(schoolId: string, id: string, patch: GuardianPatch) {
    const g = this.guardians.find((x) => x.schoolId === schoolId && x.id === id);
    if (!g) return null;
    Object.assign(g, patch);
    return this.strip(g);
  }
  async listGuardianLinks(schoolId: string, studentId: string): Promise<GuardianLink[]> {
    return this.links.filter((l) => l.schoolId === schoolId && l.studentId === studentId).flatMap((l) => {
      const g = this.guardians.find((x) => x.id === l.guardianId && x.schoolId === schoolId);
      return g ? [{ ...this.strip(g), relationship: l.relationship, isPrimaryContact: l.isPrimaryContact }] : [];
    });
  }
  async listLinkedStudents(schoolId: string, guardianId: string) {
    return this.links.filter((l) => l.schoolId === schoolId && l.guardianId === guardianId).flatMap((l) => {
      const s = this.student(schoolId, l.studentId);
      return s ? [{ ...summary(s), relationship: l.relationship, isPrimaryContact: l.isPrimaryContact }] : [];
    });
  }
  async findLink(schoolId: string, studentId: string, guardianId: string) {
    const l = this.links.find((x) => x.schoolId === schoolId && x.studentId === studentId && x.guardianId === guardianId);
    return l ? this.strip(l) : null;
  }
  async linkGuardian(schoolId: string, studentId: string, guardianId: string, relationship: GuardianRelationship, isPrimaryContact: boolean) {
    if (!this.student(schoolId, studentId) || !this.guardians.some((g) => g.schoolId === schoolId && g.id === guardianId)) return null;
    if (this.links.some((l) => l.studentId === studentId && l.guardianId === guardianId)) throw new RepositoryConflict("duplicate");
    if (isPrimaryContact) this.demoteOthers(schoolId, studentId, guardianId);
    const row: LinkRow = { schoolId, studentId, guardianId, relationship, isPrimaryContact };
    this.links.push(row);
    return this.strip(row);
  }
  async createGuardianAndLink(schoolId: string, studentId: string, input: NewGuardian, relationship: GuardianRelationship, isPrimaryContact: boolean) {
    if (!this.student(schoolId, studentId)) return null;
    const guardiansBefore = this.guardians.length;
    const linksBefore = this.links.map((l) => ({ ...l }));
    try {
      const guardian: GuardianRow = { id: randomUUID(), schoolId, ...input };
      this.guardians.push(guardian);
      if (this.failNextGuardianCreate) { this.failNextGuardianCreate = false; throw new Error("simulated database failure"); }
      const link = await this.linkGuardian(schoolId, studentId, guardian.id, relationship, isPrimaryContact);
      return { guardian: this.strip(guardian), link: link! };
    } catch (error) {
      this.guardians.length = guardiansBefore;
      this.links = linksBefore;
      throw error;
    }
  }
  async updateLink(schoolId: string, studentId: string, guardianId: string, patch: LinkPatch) {
    const l = this.links.find((x) => x.schoolId === schoolId && x.studentId === studentId && x.guardianId === guardianId);
    if (!l) return null;
    if (patch.isPrimaryContact) this.demoteOthers(schoolId, studentId, guardianId);
    Object.assign(l, patch);
    return this.strip(l);
  }
  async unlinkGuardian(schoolId: string, studentId: string, guardianId: string) {
    const before = this.links.length;
    this.links = this.links.filter((l) => !(l.schoolId === schoolId && l.studentId === studentId && l.guardianId === guardianId));
    return this.links.length < before;
  }

  // ----- enrollments -----
  async findClassRef(schoolId: string, id: string) { const c = this.classes.find((x) => x.schoolId === schoolId && x.id === id); return c ? this.strip(c) : null; }
  async findYearRef(schoolId: string, id: string) { const y = this.years.find((x) => x.schoolId === schoolId && x.id === id); return y ? this.strip(y) : null; }
  async listEnrollments(schoolId: string, studentId: string) {
    return this.enrollments.filter((e) => e.schoolId === schoolId && e.studentId === studentId).sort((a, b) => b.startDate.localeCompare(a.startDate)).map((e) => this.view(e));
  }
  async createEnrollment(schoolId: string, input: NewEnrollment) {
    this.checkOverlap(schoolId, input.studentId, input.startDate, input.endDate);
    const row: EnrollmentRow = { id: randomUUID(), schoolId, status: "ENROLLED", ...input };
    this.enrollments.push(row);
    return this.view(row);
  }
  async transferEnrollment(schoolId: string, fromId: string, oldEndDate: string, next: NewEnrollment) {
    if (this.beforeTransfer) { const hook = this.beforeTransfer; this.beforeTransfer = null; hook(); }
    const old = this.enrollments.find((e) => e.schoolId === schoolId && e.id === fromId && e.studentId === next.studentId);
    if (!old) return null;
    // Same rule as the database repository: only a still-open enrollment can be ended by a class change.
    if (old.status !== "ENROLLED") throw new RepositoryConflict("overlap");
    const before = { ...old };
    const count = this.enrollments.length;
    try {
      old.status = "CLASS_CHANGED";
      old.endDate = oldEndDate;
      if (this.failNextTransfer) { this.failNextTransfer = false; throw new Error("simulated database failure"); }
      this.checkOverlap(schoolId, next.studentId, next.startDate, next.endDate);
      const row: EnrollmentRow = { id: randomUUID(), schoolId, status: "ENROLLED", ...next };
      this.enrollments.push(row);
      return { ended: this.view(old), created: this.view(row) };
    } catch (error) {
      Object.assign(old, before);
      this.enrollments.length = count;
      throw error;
    }
  }
  async listRoster(schoolId: string, classId: string, yearId: string, includeEnded: boolean): Promise<RosterEntry[]> {
    return this.enrollments
      .filter((e) => e.schoolId === schoolId && e.classId === classId && e.academicYearId === yearId && (includeEnded || e.status === "ENROLLED"))
      .flatMap((e) => { const s = this.student(schoolId, e.studentId); return s ? [{ e, s }] : []; })
      .sort((a, b) => byName(a.s, b.s))
      .map(({ e, s }) => ({ enrollmentId: e.id, status: e.status, startDate: e.startDate, endDate: e.endDate, student: summary(s) }));
  }

  async appendAudit(event: AuditEventInput) { this.audit.push(event); }
}
