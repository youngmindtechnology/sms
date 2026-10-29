import { RepositoryConflict } from "../academic/ports.js";
import type { AuditEventInput, MembershipRecord } from "../auth/ports.js";
import type { NewStaffAccount, StaffRecord, StaffRepository, StaffRole, StaffStatus } from "../staff/ports.js";
import type { MemoryRepository } from "./memoryRepository.js";

/**
 * In-memory staff repository for tests. It works on the SAME data as the authentication fake, so an
 * account created here can really sign in, and a status change here is seen by the next request.
 */
export class MemoryStaffRepository implements StaffRepository {
  private readonly extra = new Map<string, { endedAt: string | null; createdAt: string }>();
  audit: AuditEventInput[] = [];
  /** Test hook: fail part-way through account creation, to prove nothing is left half-saved. */
  failNextCreate = false;
  failNextPasswordReset = false;

  constructor(private readonly auth: MemoryRepository, private readonly clock: () => Date = () => new Date()) {}

  private rows(schoolId: string): Array<{ userId: string; m: MembershipRecord }> {
    const out: Array<{ userId: string; m: MembershipRecord }> = [];
    for (const [userId, list] of this.auth.memberships) for (const m of list) if (m.schoolId === schoolId) out.push({ userId, m });
    return out;
  }

  private view(userId: string, m: MembershipRecord): StaffRecord {
    const user = this.auth.users.get(userId)!;
    const extra = this.extra.get(m.membershipId);
    return {
      membershipId: m.membershipId, userId, email: user.email, fullName: user.fullName, status: m.status as StaffStatus,
      roles: (m.roles as StaffRole[]).slice(), endedAt: extra?.endedAt ?? null, createdAt: extra?.createdAt ?? "2026-01-01T00:00:00.000Z",
      mustChangePassword: this.auth.credentials.get(userId)?.mustChangePassword ?? false,
    };
  }

  private find(schoolId: string, membershipId: string) {
    return this.rows(schoolId).find((r) => r.m.membershipId === membershipId) ?? null;
  }

  async listStaff(schoolId: string) {
    return this.rows(schoolId).map((r) => this.view(r.userId, r.m)).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  async findStaff(schoolId: string, membershipId: string) {
    const row = this.find(schoolId, membershipId);
    return row ? this.view(row.userId, row.m) : null;
  }
  async emailInUse(email: string) { return [...this.auth.users.values()].some((u) => u.email === email); }

  async createStaffAccount(schoolId: string, input: NewStaffAccount) {
    if ([...this.auth.users.values()].some((u) => u.email === input.email)) throw new RepositoryConflict("duplicate");
    const sample = this.rows(schoolId)[0]?.m;
    const snapshot = { users: new Map(this.auth.users), credentials: new Map(this.auth.credentials), memberships: new Map([...this.auth.memberships].map(([k, v]) => [k, v.slice()])) };
    try {
      const user = this.auth.addUser({ email: input.email, fullName: input.fullName, status: "ACTIVE" }, { passwordHash: input.passwordHash, algorithm: input.algorithm, mustChangePassword: true });
      if (this.failNextCreate) { this.failNextCreate = false; throw new Error("simulated database failure"); }
      this.auth.addMembership(user.id, { schoolId, schoolName: sample?.schoolName ?? "School", schoolStatus: sample?.schoolStatus ?? "ACTIVE", status: "ACTIVE", roles: input.roles.slice() });
      const m = this.auth.memberships.get(user.id)![0]!;
      this.extra.set(m.membershipId, { endedAt: null, createdAt: this.clock().toISOString() });
      return this.view(user.id, m);
    } catch (error) {
      this.auth.users = snapshot.users; this.auth.credentials = snapshot.credentials; this.auth.memberships = snapshot.memberships;
      throw error;
    }
  }

  private otherOwners(schoolId: string, exceptMembershipId: string) {
    return this.rows(schoolId).filter((r) => r.m.membershipId !== exceptMembershipId && r.m.status === "ACTIVE" && this.auth.users.get(r.userId)?.status === "ACTIVE" && r.m.roles.includes("OWNER")).length;
  }
  async countActiveOwners(schoolId: string, exceptMembershipId: string) { return this.otherOwners(schoolId, exceptMembershipId); }

  async setRoles(schoolId: string, membershipId: string, roles: StaffRole[], keepAnotherOwner: boolean) {
    const row = this.find(schoolId, membershipId);
    if (!row) return null;
    if (keepAnotherOwner && this.otherOwners(schoolId, membershipId) === 0) throw new RepositoryConflict("overlap");
    row.m.roles = roles.slice();
    return this.view(row.userId, row.m);
  }

  async setStatus(schoolId: string, membershipId: string, status: StaffStatus, at: Date, keepAnotherOwner: boolean) {
    const row = this.find(schoolId, membershipId);
    if (!row) return null;
    if (keepAnotherOwner && this.otherOwners(schoolId, membershipId) === 0) throw new RepositoryConflict("overlap");
    row.m.status = status;
    const extra = this.extra.get(membershipId) ?? { endedAt: null, createdAt: "2026-01-01T00:00:00.000Z" };
    extra.endedAt = status === "ENDED" ? at.toISOString() : null;
    this.extra.set(membershipId, extra);
    return this.view(row.userId, row.m);
  }

  async countOtherSchoolMemberships(schoolId: string, membershipId: string) {
    const row = this.find(schoolId, membershipId);
    if (!row) return 0;
    return (this.auth.memberships.get(row.userId) ?? []).filter((m) => m.schoolId !== schoolId).length;
  }

  async setTemporaryPassword(schoolId: string, membershipId: string, hash: string, algorithm: "argon2id" | "scrypt", at: Date) {
    const row = this.find(schoolId, membershipId);
    if (!row) return null;
    const credential = this.auth.credentials.get(row.userId);
    if (!credential) return null;
    const before = { ...credential };
    try {
      credential.passwordHash = hash; credential.algorithm = algorithm; credential.mustChangePassword = true;
      credential.failedLoginCount = 0; credential.lockedUntil = null;
      if (this.failNextPasswordReset) { this.failNextPasswordReset = false; throw new Error("simulated database failure"); }
      return await this.auth.revokeUserSessions(row.userId, at, "admin_revoked");
    } catch (error) {
      Object.assign(credential, before);
      throw error;
    }
  }

  async appendAudit(event: AuditEventInput) { this.audit.push(event); }
}
