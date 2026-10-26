import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryRepository } from "../testing/memoryRepository.js";
import { assertAuditSafe } from "./audit.js";
import { createAuthService, type AuthConfig } from "./authService.js";
import { hashPassword, verifyPassword } from "./password.js";
import { hashToken } from "./tokens.js";

const PASSWORD = "correct horse battery staple";
const SCHOOL_A = "10000000-0000-4000-8000-0000000000a1";
const SCHOOL_B = "10000000-0000-4000-8000-0000000000b1";
const SCHOOL_C = "10000000-0000-4000-8000-0000000000c1";

const config: AuthConfig = {
  session: { cookieName: "ymt_session", ttlMs: 12 * 3_600_000, idleMs: 2 * 3_600_000, secureCookie: false },
  login: { maxFailures: 3, lockoutMs: 15 * 60_000 },
};

async function setup() {
  let current = new Date("2026-10-18T08:00:00Z");
  const clock = { now: () => current, advance: (ms: number) => { current = new Date(current.getTime() + ms); } };
  const repo = new MemoryRepository(clock.now);
  const { hash, algorithm } = await hashPassword(PASSWORD, { algorithm: "scrypt", fast: true });
  const owner = repo.addUser({ email: "owner@example.test", fullName: "Test Owner", status: "ACTIVE" }, { passwordHash: hash, algorithm });
  repo.addMembership(owner.id, { schoolId: SCHOOL_A, schoolName: "Alpha", schoolStatus: "ACTIVE", status: "ACTIVE", roles: ["OWNER"] });
  const auth = createAuthService(repo, config, clock.now);
  return { repo, auth, clock, owner, hash, algorithm };
}

const login = (auth: ReturnType<typeof createAuthService>, email = "owner@example.test", password = PASSWORD) => auth.login(email, password);

test("successful login: opaque token, only hashes stored, one school auto-selected", async () => {
  const { repo, auth, owner } = await setup();
  const result = await login(auth);
  assert.ok(result.ok);
  assert.equal(result.activeSchoolId, SCHOOL_A);
  assert.equal(result.user.id, owner.id);
  assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  const stored = [...repo.sessions.values()][0]!;
  assert.ok(stored.tokenHash.equals(hashToken(result.sessionToken)));
  const dump = JSON.stringify([...repo.sessions.values()]) + JSON.stringify(repo.audit);
  assert.ok(!dump.includes(result.sessionToken), "raw session token reached storage");
  assert.ok(!dump.includes(result.csrfToken), "raw CSRF token reached storage");
  assert.ok(!dump.includes(PASSWORD), "password reached storage");
  assert.equal(result.expiresAt.getTime(), new Date("2026-10-18T20:00:00Z").getTime());
});

test("every failure looks identical to the client", async () => {
  const { repo, auth, owner } = await setup();
  const disabled = repo.addUser({ email: "off@example.test", fullName: "Off", status: "DISABLED" }, { passwordHash: (await hashPassword(PASSWORD, { algorithm: "scrypt", fast: true })).hash, algorithm: "scrypt" });
  repo.addUser({ email: "nocred@example.test", fullName: "NoCred", status: "ACTIVE" });
  const outcomes = [
    await login(auth, "nobody@example.test"),
    await login(auth, "owner@example.test", "wrong password!!"),
    await login(auth, "off@example.test"),
    await login(auth, "nocred@example.test"),
    await login(auth, "", ""),
  ];
  for (const outcome of outcomes) assert.deepEqual(outcome, { ok: false });
  void owner; void disabled;
});

test("email is matched case-insensitively and trimmed", async () => {
  const { auth } = await setup();
  assert.ok((await login(auth, "  OWNER@Example.TEST ")).ok);
});

test("lockout after repeated failures; correct password still refused while locked; works after expiry", async () => {
  const { repo, auth, clock, owner } = await setup();
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await login(auth, "owner@example.test", "wrong password!!"), { ok: false });
  assert.ok(repo.credentials.get(owner.id)!.lockedUntil);
  assert.deepEqual(await login(auth), { ok: false }); // right password, but locked
  assert.ok(repo.audit.some((e) => e.action === "auth.account.locked"));
  clock.advance(16 * 60_000);
  assert.ok((await login(auth)).ok);
  assert.equal(repo.credentials.get(owner.id)!.failedLoginCount, 0);
  assert.equal(repo.credentials.get(owner.id)!.lockedUntil, null);
});

test("a successful login resets the failure counter", async () => {
  const { repo, auth, owner } = await setup();
  await login(auth, "owner@example.test", "wrong password!!");
  await login(auth, "owner@example.test", "wrong password!!");
  assert.equal(repo.credentials.get(owner.id)!.failedLoginCount, 2);
  assert.ok((await login(auth)).ok);
  assert.equal(repo.credentials.get(owner.id)!.failedLoginCount, 0);
});

test("INVITED and DISABLED users cannot sign in even with the right password", async () => {
  const { repo, auth } = await setup();
  const { hash } = await hashPassword(PASSWORD, { algorithm: "scrypt", fast: true });
  repo.addUser({ email: "invited@example.test", fullName: "I", status: "INVITED" }, { passwordHash: hash, algorithm: "scrypt" });
  repo.addUser({ email: "disabled@example.test", fullName: "D", status: "DISABLED" }, { passwordHash: hash, algorithm: "scrypt" });
  assert.deepEqual(await login(auth, "invited@example.test"), { ok: false });
  assert.deepEqual(await login(auth, "disabled@example.test"), { ok: false });
  assert.equal(repo.sessions.size, 0);
});

test("several schools: no school is chosen automatically; suspended schools and ended memberships are not offered", async () => {
  const { repo, auth, owner } = await setup();
  repo.addMembership(owner.id, { schoolId: SCHOOL_B, schoolName: "Bravo", schoolStatus: "ACTIVE", status: "ACTIVE", roles: ["TEACHER"] });
  repo.addMembership(owner.id, { schoolId: SCHOOL_C, schoolName: "Charlie", schoolStatus: "SUSPENDED", status: "ACTIVE", roles: ["OWNER"] });
  repo.addMembership(owner.id, { schoolId: "10000000-0000-4000-8000-0000000000d1", schoolName: "Delta", schoolStatus: "ACTIVE", status: "ENDED", roles: ["OWNER"] });
  const result = await login(auth);
  assert.ok(result.ok);
  assert.equal(result.activeSchoolId, null);
  assert.deepEqual(result.schools.map((s) => s.schoolId).sort(), [SCHOOL_A, SCHOOL_B]);
});

test("authenticate: valid session resolves user, school and permissions", async () => {
  const { auth } = await setup();
  const result = await login(auth);
  assert.ok(result.ok);
  const ctx = await auth.authenticate(result.sessionToken);
  assert.ok(ctx);
  assert.equal(ctx.school?.id, SCHOOL_A);
  assert.ok(ctx.school?.permissions.has("fees:manage"));
  assert.equal(await auth.authenticate("A".repeat(43)), null);
});

test("authenticate: expired, idle, revoked and disabled-user sessions are rejected", async () => {
  const { repo, auth, clock, owner } = await setup();
  const a = await login(auth);
  assert.ok(a.ok);
  clock.advance(2 * 3_600_000 + 1000); // beyond the idle limit
  assert.equal(await auth.authenticate(a.sessionToken), null);

  const b = await login(auth);
  assert.ok(b.ok);
  for (let hour = 1; hour <= 11; hour += 1) {
    clock.advance(3_600_000); // active every hour: never idle
    assert.ok(await auth.authenticate(b.sessionToken), `still valid after ${hour} h of activity`);
  }
  clock.advance(1.5 * 3_600_000); // 12.5 h after login: beyond the absolute 12 h lifetime
  assert.equal(await auth.authenticate(b.sessionToken), null, "absolute lifetime must end the session");

  const c = await login(auth);
  assert.ok(c.ok);
  const ctx = (await auth.authenticate(c.sessionToken))!;
  await auth.logout(ctx);
  assert.equal(await auth.authenticate(c.sessionToken), null, "revoked session must not authenticate");

  const d = await login(auth);
  assert.ok(d.ok);
  repo.users.get(owner.id)!.status = "DISABLED";
  assert.equal(await auth.authenticate(d.sessionToken), null, "disabling a user ends their sessions");
});

test("authenticate: a school suspended or a membership ended after login removes the school but not the user", async () => {
  const { repo, auth, owner } = await setup();
  const result = await login(auth);
  assert.ok(result.ok);
  repo.memberships.get(owner.id)![0]!.schoolStatus = "SUSPENDED";
  let ctx = await auth.authenticate(result.sessionToken);
  assert.ok(ctx);
  assert.equal(ctx.school, null);
  repo.memberships.get(owner.id)![0]!.schoolStatus = "ACTIVE";
  repo.memberships.get(owner.id)![0]!.status = "ENDED";
  ctx = await auth.authenticate(result.sessionToken);
  assert.equal(ctx?.school, null);
  repo.memberships.get(owner.id)![0]!.status = "ACTIVE";
  repo.memberships.get(owner.id)![0]!.roles = ["TEACHER"]; // roles are read fresh every request
  ctx = await auth.authenticate(result.sessionToken);
  assert.equal(ctx?.school?.permissions.has("payments:record"), false);
});

test("CSRF: only the matching derived token is accepted", async () => {
  const { auth } = await setup();
  const one = await login(auth);
  const two = await login(auth);
  assert.ok(one.ok && two.ok);
  assert.equal(await auth.csrfMatches(one.sessionToken, one.csrfToken), true);
  assert.equal(await auth.csrfMatches(one.sessionToken, auth.csrfTokenFor(one.sessionToken)), true); // recomputed after a page reload
  assert.equal(await auth.csrfMatches(one.sessionToken, two.csrfToken), false);
  assert.equal(await auth.csrfMatches(one.sessionToken, undefined), false);
  assert.equal(await auth.csrfMatches(one.sessionToken, ""), false);
  assert.equal(await auth.csrfMatches("B".repeat(43), one.csrfToken), false);
});

test("switch-school: only an active membership in an active school; a guessed id is denied and changes nothing", async () => {
  const { repo, auth, owner } = await setup();
  repo.addMembership(owner.id, { schoolId: SCHOOL_B, schoolName: "Bravo", schoolStatus: "ACTIVE", status: "ACTIVE", roles: ["TEACHER"] });
  repo.addMembership(owner.id, { schoolId: SCHOOL_C, schoolName: "Charlie", schoolStatus: "SUSPENDED", status: "ACTIVE", roles: ["OWNER"] });
  const result = await login(auth);
  assert.ok(result.ok);
  const ctx = (await auth.authenticate(result.sessionToken))!;

  assert.deepEqual(await auth.switchSchool(ctx, SCHOOL_B), { ok: true });
  assert.equal((await auth.authenticate(result.sessionToken))?.school?.id, SCHOOL_B);
  assert.equal((await auth.authenticate(result.sessionToken))?.school?.permissions.has("fees:manage"), false); // TEACHER in B

  for (const bad of [SCHOOL_C, "10000000-0000-4000-8000-0000000000ee", "", "' OR 1=1 --", "../../etc"]) {
    assert.deepEqual(await auth.switchSchool(ctx, bad), { ok: false }, bad);
  }
  assert.equal((await auth.authenticate(result.sessionToken))?.school?.id, SCHOOL_B, "denied switches must not change the session");
  assert.ok(repo.audit.some((e) => e.action === "auth.school_switch.denied"));
});

test("change password: wrong current, weak new, success revokes other sessions only, old password stops working", async () => {
  const { repo, auth, owner } = await setup();
  const first = await login(auth);
  const second = await login(auth);
  assert.ok(first.ok && second.ok);
  const ctx = (await auth.authenticate(first.sessionToken))!;

  assert.deepEqual(await auth.changePassword(ctx, "wrong current!!", "A brand new passphrase"), { ok: false, reason: "wrong_password" });
  const weak = await auth.changePassword(ctx, PASSWORD, "short");
  assert.equal(weak.ok, false);
  assert.equal(weak.ok === false && weak.reason, "weak_password");
  assert.deepEqual(await auth.changePassword(ctx, PASSWORD, PASSWORD), { ok: false, reason: "weak_password", problems: ["too_common"] });

  assert.deepEqual(await auth.changePassword(ctx, PASSWORD, "A brand new passphrase"), { ok: true });
  assert.ok(await auth.authenticate(first.sessionToken), "the session that changed the password continues");
  assert.equal(await auth.authenticate(second.sessionToken), null, "other sessions end");
  assert.deepEqual(await login(auth), { ok: false });
  assert.ok((await login(auth, "owner@example.test", "A brand new passphrase")).ok);
  assert.equal((await verifyPassword("A brand new passphrase", repo.credentials.get(owner.id)!.passwordHash)).ok, true);
});

test("a cheap stored hash is upgraded after a successful login", async () => {
  const { repo, auth, owner, hash } = await setup();
  assert.ok((await login(auth)).ok);
  const after = repo.credentials.get(owner.id)!.passwordHash;
  assert.notEqual(after, hash);
  assert.equal((await verifyPassword(PASSWORD, after)).ok, true);
});

test("audit events carry no secrets and cover the main actions", async () => {
  const { repo, auth } = await setup();
  const ok = await login(auth);
  assert.ok(ok.ok);
  await login(auth, "nobody@example.test", "some password value!");
  await login(auth, "owner@example.test", "wrong password!!");
  const ctx = (await auth.authenticate(ok.sessionToken))!;
  await auth.logout(ctx);
  const actions = repo.audit.map((e) => e.action);
  for (const expected of ["auth.login.succeeded", "auth.login.failed", "auth.logout"]) assert.ok(actions.includes(expected), expected);
  const dump = JSON.stringify(repo.audit);
  for (const secret of [PASSWORD, "wrong password!!", "some password value!", ok.sessionToken, ok.csrfToken, "nobody@example.test"]) {
    assert.ok(!dump.includes(secret), `audit leaked: ${secret.slice(0, 6)}...`);
  }
});

test("assertAuditSafe refuses secret-looking keys and values", () => {
  assert.throws(() => assertAuditSafe({ password: "x" }));
  assert.throws(() => assertAuditSafe({ nested: { sessionToken: "x" } }));
  assert.throws(() => assertAuditSafe({ note: "A".repeat(43) }));
  assert.throws(() => assertAuditSafe({ note: "$argon2id$v=19$m=1,t=1,p=1$aa$bb" }));
  assert.doesNotThrow(() => assertAuditSafe({ reason: "bad_password", failures: 2 }));
});
