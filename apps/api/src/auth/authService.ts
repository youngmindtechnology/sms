import type { AppConfig } from "../config.js";
import { recordAudit } from "./audit.js";
import { checkPasswordPolicy, hashPassword, verifyAgainstDummy, verifyPassword } from "./password.js";
import { permissionsFor, type Permission } from "./permissions.js";
import type { AuthRepository, MembershipRecord, SessionRecord, UserRecord } from "./ports.js";
import { deriveCsrfToken, generateToken, hashToken, safeEqual } from "./tokens.js";

export type AuthConfig = Pick<AppConfig, "session" | "login">;

export interface SchoolChoice {
  schoolId: string;
  schoolName: string;
  roles: string[];
}

export interface AuthContext {
  sessionId: string;
  user: { id: string; email: string; fullName: string };
  /** Set only when the session's school is still valid (active membership, active school). */
  school: { id: string; name: string; roles: string[]; permissions: Set<Permission> } | null;
  /** Schools the user may switch to right now. */
  schools: SchoolChoice[];
  /** A temporary password is still in use: only changing it (and signing out) is allowed until it is replaced. */
  mustChangePassword: boolean;
}

export interface LoginSuccess {
  ok: true;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  user: { id: string; email: string; fullName: string };
  activeSchoolId: string | null;
  schools: SchoolChoice[];
  mustChangePassword: boolean;
}
/** One failure shape for every reason, so the client cannot tell them apart. */
export interface LoginFailure {
  ok: false;
}

const usableMemberships = (memberships: MembershipRecord[]) =>
  memberships.filter((m) => m.status === "ACTIVE" && m.schoolStatus === "ACTIVE");

const toChoice = (m: MembershipRecord): SchoolChoice => ({ schoolId: m.schoolId, schoolName: m.schoolName, roles: m.roles });

export function normaliseEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

export function createAuthService(repo: AuthRepository, config: AuthConfig, now: () => Date = () => new Date()) {
  async function issueSession(userId: string, activeSchoolId: string | null) {
    const sessionToken = generateToken();
    const csrfToken = deriveCsrfToken(sessionToken);
    const expiresAt = new Date(now().getTime() + config.session.ttlMs);
    await repo.createSession({
      userId,
      tokenHash: hashToken(sessionToken),
      csrfTokenHash: hashToken(csrfToken),
      activeSchoolId,
      expiresAt,
    });
    return { sessionToken, csrfToken, expiresAt };
  }

  async function login(emailInput: string, password: string): Promise<LoginSuccess | LoginFailure> {
    const email = normaliseEmail(emailInput);
    const found = await repo.findUserByEmail(email);
    const at = now();

    // Unknown user or no credential: spend the same time as a real check.
    if (!found || !found.credential) {
      await verifyAgainstDummy(password);
      await recordAudit(repo, {
        schoolId: null, actorUserId: found?.user.id ?? null, action: "auth.login.failed",
        entityType: "user", entityId: found?.user.id ?? null, metadata: { reason: "unknown_or_no_credential" },
      });
      return { ok: false };
    }
    const { user, credential } = found;

    if (credential.lockedUntil && credential.lockedUntil > at) {
      await verifyAgainstDummy(password);
      await recordAudit(repo, {
        schoolId: null, actorUserId: user.id, action: "auth.login.failed",
        entityType: "user", entityId: user.id, metadata: { reason: "locked" },
      });
      return { ok: false };
    }

    const result = await verifyPassword(password, credential.passwordHash);
    if (!result.ok || user.status !== "ACTIVE") {
      if (!result.ok) {
        const failures = credential.failedLoginCount + 1;
        const lock = failures >= config.login.maxFailures ? new Date(at.getTime() + config.login.lockoutMs) : null;
        await repo.recordFailedLogin(user.id, lock);
        await recordAudit(repo, {
          schoolId: null, actorUserId: user.id, action: lock ? "auth.account.locked" : "auth.login.failed",
          entityType: "user", entityId: user.id, metadata: { reason: "bad_password", failures },
        });
      } else {
        await recordAudit(repo, {
          schoolId: null, actorUserId: user.id, action: "auth.login.failed",
          entityType: "user", entityId: user.id, metadata: { reason: "user_not_active", status: user.status },
        });
      }
      return { ok: false };
    }

    await repo.recordSuccessfulLogin(user.id);
    if (result.needsRehash) {
      const upgraded = await hashPassword(password);
      await repo.replacePasswordHash(user.id, upgraded.hash, upgraded.algorithm, at);
    }

    const schools = usableMemberships(await repo.listMemberships(user.id));
    // One usable school: select it. Several: the person chooses (switch-school).
    const activeSchoolId = schools.length === 1 ? schools[0]!.schoolId : null;
    const session = await issueSession(user.id, activeSchoolId);
    await recordAudit(repo, {
      schoolId: activeSchoolId, actorUserId: user.id, action: "auth.login.succeeded",
      entityType: "user", entityId: user.id, metadata: {},
    });
    return {
      ok: true, ...session,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      activeSchoolId,
      schools: schools.map(toChoice),
      mustChangePassword: credential.mustChangePassword,
    };
  }

  /** Resolves a session cookie to who is acting and for which school, or null. */
  async function authenticate(sessionToken: string): Promise<AuthContext | null> {
    const session = await repo.findSessionByTokenHash(hashToken(sessionToken));
    if (!session) return null;
    const at = now();
    if (session.revokedAt || session.expiresAt <= at) return null;
    if (at.getTime() - session.lastSeenAt.getTime() > config.session.idleMs) return null;

    const user = await repo.findUserById(session.userId);
    if (!user || user.status !== "ACTIVE") return null;

    // Touch at most once a minute to avoid a write on every request.
    if (at.getTime() - session.lastSeenAt.getTime() > 60_000) await repo.touchSession(session.id, at);

    const mustChangePassword = (await repo.findCredential(user.id))?.mustChangePassword ?? false;
    const schools = usableMemberships(await repo.listMemberships(user.id));
    const current = session.activeSchoolId ? schools.find((m) => m.schoolId === session.activeSchoolId) : undefined;
    return {
      sessionId: session.id,
      user: { id: user.id, email: user.email, fullName: user.fullName },
      school: current
        ? { id: current.schoolId, name: current.schoolName, roles: current.roles, permissions: permissionsFor(current.roles) }
        : null,
      schools: schools.map(toChoice),
      mustChangePassword,
    };
  }

  /** The header the browser sends must hash to the value stored for this session. */
  async function csrfMatches(sessionToken: string, presented: string | undefined): Promise<boolean> {
    if (!presented) return false;
    const session = await repo.findSessionByTokenHash(hashToken(sessionToken));
    if (!session) return false;
    return safeEqual(hashToken(presented), session.csrfTokenHash);
  }

  /** The CSRF token for an authenticated session (recomputed, never stored raw). */
  const csrfTokenFor = (sessionToken: string) => deriveCsrfToken(sessionToken);

  async function logout(ctx: AuthContext): Promise<void> {
    await repo.revokeSession(ctx.sessionId, now(), "logout");
    await recordAudit(repo, {
      schoolId: ctx.school?.id ?? null, actorUserId: ctx.user.id, action: "auth.logout",
      entityType: "session", entityId: ctx.sessionId, metadata: {},
    });
  }

  /**
   * Switch the session's school. The requested id comes from the client and is
   * NEVER trusted: it must be one of the user's own active memberships in an
   * active school, looked up fresh from the database.
   */
  async function switchSchool(ctx: AuthContext, requestedSchoolId: string): Promise<{ ok: true } | { ok: false }> {
    const allowed = usableMemberships(await repo.listMemberships(ctx.user.id)).find((m) => m.schoolId === requestedSchoolId);
    if (!allowed) {
      await recordAudit(repo, {
        schoolId: null, actorUserId: ctx.user.id, action: "auth.school_switch.denied",
        entityType: "session", entityId: ctx.sessionId, metadata: {},
      });
      return { ok: false };
    }
    await repo.setActiveSchool(ctx.sessionId, allowed.schoolId);
    await recordAudit(repo, {
      schoolId: allowed.schoolId, actorUserId: ctx.user.id, action: "auth.school_switch",
      entityType: "session", entityId: ctx.sessionId, metadata: {},
    });
    return { ok: true };
  }

  async function changePassword(
    ctx: AuthContext,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true } | { ok: false; reason: "wrong_password" | "weak_password"; problems?: string[] }> {
    const credential = await repo.findCredential(ctx.user.id);
    const verified = credential ? await verifyPassword(currentPassword, credential.passwordHash) : await verifyAgainstDummy(currentPassword);
    if (!credential || !verified.ok) {
      await recordAudit(repo, {
        schoolId: ctx.school?.id ?? null, actorUserId: ctx.user.id, action: "auth.password_change.failed",
        entityType: "user", entityId: ctx.user.id, metadata: { reason: "wrong_password" },
      });
      return { ok: false, reason: "wrong_password" };
    }
    const problems = checkPasswordPolicy(newPassword, { email: ctx.user.email });
    if (newPassword === currentPassword) problems.push("too_common");
    if (problems.length > 0) return { ok: false, reason: "weak_password", problems };

    const at = now();
    const next = await hashPassword(newPassword);
    await repo.replacePasswordHash(ctx.user.id, next.hash, next.algorithm, at, true);
    // Every other session of this user ends; the current one continues.
    const revoked = await repo.revokeUserSessions(ctx.user.id, at, "password_changed", ctx.sessionId);
    await recordAudit(repo, {
      schoolId: ctx.school?.id ?? null, actorUserId: ctx.user.id, action: "auth.password_changed",
      entityType: "user", entityId: ctx.user.id, metadata: { otherSessionsRevoked: revoked },
    });
    return { ok: true };
  }

  return { login, authenticate, csrfMatches, csrfTokenFor, logout, switchSchool, changePassword };
}

export type AuthService = ReturnType<typeof createAuthService>;
export type { SessionRecord, UserRecord };
