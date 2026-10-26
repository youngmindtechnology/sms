import { randomUUID } from "node:crypto";
import type {
  AuditEventInput, AuthRepository, CredentialRecord, MembershipRecord, NewSession, RevokeReason, SessionRecord, UserRecord,
} from "../auth/ports.js";

/** In-memory stand-in for the database, used only by tests. */
export class MemoryRepository implements AuthRepository {
  users = new Map<string, UserRecord>();
  credentials = new Map<string, CredentialRecord>();
  memberships = new Map<string, MembershipRecord[]>();
  sessions = new Map<string, SessionRecord & { tokenHash: Buffer; revokedReason: RevokeReason | null }>();
  audit: AuditEventInput[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  addUser(user: Omit<UserRecord, "id"> & { id?: string }, credential?: Pick<CredentialRecord, "passwordHash" | "algorithm">): UserRecord {
    const record: UserRecord = { id: user.id ?? randomUUID(), email: user.email, fullName: user.fullName, status: user.status };
    this.users.set(record.id, record);
    if (credential) {
      this.credentials.set(record.id, { userId: record.id, ...credential, failedLoginCount: 0, lockedUntil: null });
    }
    return record;
  }

  addMembership(userId: string, membership: Omit<MembershipRecord, "membershipId">): void {
    const list = this.memberships.get(userId) ?? [];
    list.push({ membershipId: randomUUID(), ...membership });
    this.memberships.set(userId, list);
  }

  async findUserByEmail(email: string) {
    const user = [...this.users.values()].find((u) => u.email === email);
    return user ? { user, credential: this.credentials.get(user.id) ?? null } : null;
  }
  async findUserById(id: string) { return this.users.get(id) ?? null; }
  async findCredential(userId: string) { return this.credentials.get(userId) ?? null; }
  async listMemberships(userId: string) { return (this.memberships.get(userId) ?? []).map((m) => ({ ...m, roles: [...m.roles] })); }

  async recordFailedLogin(userId: string, lockUntil: Date | null) {
    const c = this.credentials.get(userId)!;
    c.failedLoginCount += 1;
    if (lockUntil) c.lockedUntil = lockUntil;
  }
  async recordSuccessfulLogin(userId: string) {
    const c = this.credentials.get(userId)!;
    c.failedLoginCount = 0;
    c.lockedUntil = null;
  }
  async replacePasswordHash(userId: string, hash: string, algorithm: "argon2id" | "scrypt") {
    const c = this.credentials.get(userId)!;
    c.passwordHash = hash;
    c.algorithm = algorithm;
  }

  async createSession(input: NewSession) {
    const now = this.clock();
    const session = {
      id: randomUUID(), userId: input.userId, activeSchoolId: input.activeSchoolId, createdAt: now, lastSeenAt: now,
      expiresAt: input.expiresAt, revokedAt: null, csrfTokenHash: input.csrfTokenHash, tokenHash: input.tokenHash, revokedReason: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }
  async findSessionByTokenHash(tokenHash: Buffer) {
    return [...this.sessions.values()].find((s) => s.tokenHash.equals(tokenHash)) ?? null;
  }
  async touchSession(sessionId: string, at: Date) { this.sessions.get(sessionId)!.lastSeenAt = at; }
  async setActiveSchool(sessionId: string, schoolId: string) { this.sessions.get(sessionId)!.activeSchoolId = schoolId; }
  async revokeSession(sessionId: string, at: Date, reason: RevokeReason) {
    const s = this.sessions.get(sessionId)!;
    s.revokedAt = at;
    s.revokedReason = reason;
  }
  async revokeUserSessions(userId: string, at: Date, reason: RevokeReason, exceptSessionId?: string) {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.userId === userId && !s.revokedAt && s.id !== exceptSessionId) {
        s.revokedAt = at;
        s.revokedReason = reason;
        count += 1;
      }
    }
    return count;
  }
  async appendAudit(event: AuditEventInput) { this.audit.push(event); }
}
