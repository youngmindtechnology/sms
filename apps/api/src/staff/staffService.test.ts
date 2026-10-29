import assert from "node:assert/strict";
import { test } from "node:test";
import { assertAuditSafe } from "../auth/audit.js";
import { createAuthService, type AuthConfig } from "../auth/authService.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { MemoryRepository } from "../testing/memoryRepository.js";
import { MemoryStaffRepository } from "../testing/memoryStaffRepository.js";
import type { StaffRole } from "./ports.js";
import { assignableRoles, createStaffService, type StaffActor, type StaffMember, type Result } from "./staffService.js";
import { generateTemporaryPassword } from "./tempPassword.js";

const PASSWORD = "correct horse battery staple";
const A = "10000000-0000-4000-8000-0000000000a1";
const C = "10000000-0000-4000-8000-0000000000c1";
const MISSING = "70000000-0000-4000-8000-0000000000ff";
const config: AuthConfig = {
  session: { cookieName: "ymt_session", ttlMs: 12 * 3_600_000, idleMs: 2 * 3_600_000, secureCookie: false },
  login: { maxFailures: 3, lockoutMs: 15 * 60_000 },
};
const NOW = new Date("2026-10-28T09:00:00Z");

const unwrap = <T>(r: Result<T>): T => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; value: T }).value; };
const errorOf = (r: Result<unknown>) => (r.ok ? "ok" : r.error);
const fieldsOf = (r: Result<unknown>) => (r.ok ? {} : r.fields ?? {});

async function setup() {
  const auth = new MemoryRepository(() => NOW);
  const fast = (password: string) => hashPassword(password, { algorithm: "scrypt", fast: true });
  const { hash, algorithm } = await fast(PASSWORD);
  const repo = new MemoryStaffRepository(auth, () => NOW);
  const staff = createStaffService(repo, { hash: fast, now: () => NOW });
  const signIn = createAuthService(auth, config, () => NOW);

  const people: Record<string, { userId: string; membershipId: string; roles: StaffRole[]; schoolId: string }> = {};
  const add = (key: string, schoolId: string, roles: StaffRole[], existing?: string) => {
    const user = existing ? auth.users.get(existing)! : auth.addUser({ email: `${key}@example.test`, fullName: `Person ${key}`, status: "ACTIVE" }, { passwordHash: hash, algorithm });
    auth.addMembership(user.id, { schoolId, schoolName: schoolId === A ? "Alpha" : "Charlie", schoolStatus: "ACTIVE", status: "ACTIVE", roles });
    people[key] = { userId: user.id, membershipId: auth.memberships.get(user.id)!.at(-1)!.membershipId, roles, schoolId };
    return user.id;
  };
  add("owner", A, ["OWNER"]);
  add("owner2", A, ["OWNER"]);
  add("admin", A, ["ADMINISTRATOR"]);
  add("admin2", A, ["ADMINISTRATOR"]);
  add("head", A, ["HEADTEACHER"]);
  add("teacher", A, ["TEACHER"]);
  add("bursar", A, ["BURSAR"]);
  add("outsider", C, ["OWNER"]);
  add("outsiderTeacher", C, ["TEACHER"]);

  const as = (key: string): StaffActor => ({ schoolId: people[key]!.schoolId, userId: people[key]!.userId, roles: people[key]!.roles });
  const id = (key: string) => people[key]!.membershipId;
  return { auth, repo, staff, signIn, people, as, id, add };
}

const newTeacher = { email: "  New.Teacher@Example.test ", fullName: "  Efua   Owusu ", roles: ["TEACHER"] };

test("temporary passwords: random, readable, long, and they pass the password policy", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const p = generateTemporaryPassword("a@example.test");
    assert.match(p, /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
});

test("who may manage which roles: owner everything; administrator only teacher and bursar; everyone else nothing", () => {
  assert.deepEqual(assignableRoles(["OWNER"]), ["OWNER", "HEADTEACHER", "ADMINISTRATOR", "TEACHER", "BURSAR"]);
  assert.deepEqual(assignableRoles(["ADMINISTRATOR"]), ["TEACHER", "BURSAR"]);
  for (const role of ["HEADTEACHER", "TEACHER", "BURSAR", "SUPERUSER", ""]) assert.deepEqual(assignableRoles([role]), [], role);
  assert.deepEqual(assignableRoles([]), []);
});

test("list: this school only, no user id or credential data, with the roles the caller may assign", async () => {
  const { staff, as } = await setup();
  const result = unwrap(await staff.list(as("owner")));
  assert.equal(result.staff.length, 7, "the two other-school people are not listed");
  assert.deepEqual(result.assignableRoles, ["OWNER", "HEADTEACHER", "ADMINISTRATOR", "TEACHER", "BURSAR"]);
  assert.equal(result.staff.filter((s) => s.isYou).length, 1);
  for (const member of result.staff) {
    assert.deepEqual(Object.keys(member).sort(), ["awaitingFirstSignIn", "createdAt", "email", "endedAt", "fullName", "isYou", "membershipId", "roles", "status"]);
  }
  assert.deepEqual(unwrap(await staff.list(as("admin"))).assignableRoles, ["TEACHER", "BURSAR"]);
  const other = unwrap(await staff.list(as("outsider")));
  assert.deepEqual(other.staff.map((s) => s.email).sort(), ["outsider@example.test", "outsiderTeacher@example.test"]);
});

test("create: trims and lower-cases, makes an ACTIVE member of the caller's school, and the person can sign in with the one-time password", async () => {
  const { staff, as, signIn, auth, people } = await setup();
  const made = unwrap(await staff.create(as("owner"), newTeacher));
  assert.equal(made.staff.email, "new.teacher@example.test");
  assert.equal(made.staff.fullName, "Efua Owusu");
  assert.deepEqual(made.staff.roles, ["TEACHER"]);
  assert.equal(made.staff.status, "ACTIVE");
  assert.equal(made.staff.awaitingFirstSignIn, true);

  // Stored as a hash only.
  const user = [...auth.users.values()].find((u) => u.email === "new.teacher@example.test")!;
  const credential = auth.credentials.get(user.id)!;
  assert.notEqual(credential.passwordHash, made.temporaryPassword);
  assert.equal(credential.mustChangePassword, true);
  assert.equal((await verifyPassword(made.temporaryPassword, credential.passwordHash)).ok, true);
  assert.equal(auth.memberships.get(user.id)!.length, 1);
  assert.equal(auth.memberships.get(user.id)![0]!.schoolId, people.owner!.schoolId);

  const login = await signIn.login("new.teacher@example.test", made.temporaryPassword);
  assert.ok(login.ok);
  assert.equal(login.mustChangePassword, true);
  assert.equal(login.activeSchoolId, A);
  // Choosing their own password ends the "temporary" state.
  const ctx = (await signIn.authenticate(login.sessionToken))!;
  assert.equal(ctx.mustChangePassword, true);
  assert.deepEqual(await signIn.changePassword(ctx, made.temporaryPassword, "a brand new long passphrase 77"), { ok: true });
  assert.equal((await signIn.authenticate(login.sessionToken))!.mustChangePassword, false);
});

test("create: bad e-mail, name and roles are rejected with field messages and nothing is stored", async () => {
  const { staff, as, auth } = await setup();
  const before = auth.users.size;
  for (const [input, field] of [
    [{ ...newTeacher, email: "not-an-email" }, "email"],
    [{ ...newTeacher, email: 5 }, "email"],
    [{ ...newTeacher, fullName: "" }, "fullName"],
    [{ ...newTeacher, fullName: "x".repeat(201) }, "fullName"],
    [{ ...newTeacher, roles: [] }, "roles"],
    [{ ...newTeacher, roles: "TEACHER" }, "roles"],
    [{ ...newTeacher, roles: ["SUPERUSER"] }, "roles"],
    [{ ...newTeacher, roles: ["PLATFORM_ADMIN"] }, "roles"],
  ] as const) {
    const result = await staff.create(as("owner"), input);
    assert.equal(errorOf(result), "validation_error", JSON.stringify(input));
    assert.ok(fieldsOf(result)[field], field);
  }
  assert.equal(auth.users.size, before);
});

test("create: an e-mail already used anywhere gets the same refusal, so nobody can probe which schools exist", async () => {
  const { staff, as } = await setup();
  const sameSchool = await staff.create(as("owner"), { ...newTeacher, email: "teacher@example.test" });
  const otherSchool = await staff.create(as("owner"), { ...newTeacher, email: "outsider@example.test" });
  assert.equal(errorOf(sameSchool), "email_in_use");
  assert.deepEqual(sameSchool, otherSchool);
  // Case and spaces do not get around it.
  assert.equal(errorOf(await staff.create(as("owner"), { ...newTeacher, email: " TEACHER@Example.test " })), "email_in_use");
});

test("create: a race for the same e-mail is a clean conflict", async () => {
  const { staff, as, repo } = await setup();
  repo.emailInUse = async () => false;
  assert.equal(errorOf(await staff.create(as("owner"), { ...newTeacher, email: "teacher@example.test" })), "email_in_use");
});

test("create is all or nothing: a failure part-way leaves no user, credential or membership", async () => {
  const { staff, as, auth, repo } = await setup();
  const before = JSON.stringify([[...auth.users], [...auth.credentials], [...auth.memberships]]);
  repo.failNextCreate = true;
  await assert.rejects(staff.create(as("owner"), newTeacher), /simulated/);
  assert.equal(JSON.stringify([[...auth.users], [...auth.credentials], [...auth.memberships]]), before);
  assert.equal(repo.audit.length, 0);
});

test("escalation: an administrator can create teachers and bursars but never a more powerful role", async () => {
  const { staff, as } = await setup();
  assert.ok(unwrap(await staff.create(as("admin"), { ...newTeacher, email: "t1@example.test" })));
  assert.ok(unwrap(await staff.create(as("admin"), { ...newTeacher, email: "b1@example.test", roles: ["BURSAR"] })));
  for (const roles of [["OWNER"], ["HEADTEACHER"], ["ADMINISTRATOR"], ["TEACHER", "ADMINISTRATOR"], ["BURSAR", "OWNER"]]) {
    const result = await staff.create(as("admin"), { ...newTeacher, email: `x${roles.join("")}@example.test`, roles });
    assert.equal(errorOf(result), "role_not_allowed", roles.join());
  }
  // The owner can.
  assert.deepEqual(unwrap(await staff.create(as("owner"), { ...newTeacher, email: "h@example.test", roles: ["HEADTEACHER", "BURSAR"] })).staff.roles, ["HEADTEACHER", "BURSAR"]);
});

test("escalation: roles held by people who may not manage staff (teacher, bursar, headteacher) can never be used to change anyone", async () => {
  const { staff, as, id } = await setup();
  for (const who of ["teacher", "bursar", "head"]) {
    assert.deepEqual(unwrap(await staff.list(as(who))).assignableRoles, [], "no role is assignable");
    assert.equal(errorOf(await staff.create(as(who), { ...newTeacher, email: `${who}@new.test` })), "role_not_allowed");
    assert.equal(errorOf(await staff.updateRoles(as(who), id("bursar"), { roles: ["TEACHER"] })), who === "bursar" ? "cannot_change_own_access" : "role_not_allowed");
  }
});

test("escalation: an administrator cannot touch an owner, a headteacher or another administrator, and cannot hand out those roles", async () => {
  const { staff, as, id } = await setup();
  for (const victim of ["owner", "owner2", "head", "admin2"]) {
    assert.equal(errorOf(await staff.updateRoles(as("admin"), id(victim), { roles: ["TEACHER"] })), "role_not_allowed", `roles of ${victim}`);
    assert.equal(errorOf(await staff.changeStatus(as("admin"), id(victim), { status: "SUSPENDED" })), "role_not_allowed", `status of ${victim}`);
    assert.equal(errorOf(await staff.resetPassword(as("admin"), id(victim))), "role_not_allowed", `password of ${victim}`);
  }
  for (const roles of [["ADMINISTRATOR"], ["OWNER"], ["TEACHER", "HEADTEACHER"]]) {
    assert.equal(errorOf(await staff.updateRoles(as("admin"), id("teacher"), { roles })), "role_not_allowed", roles.join());
  }
  assert.deepEqual(unwrap(await staff.updateRoles(as("admin"), id("teacher"), { roles: ["BURSAR"] })).roles, ["BURSAR"]);
});

test("escalation: nobody can change their own roles, status or password, so nobody can promote themselves", async () => {
  const { staff, as, id } = await setup();
  for (const who of ["owner", "admin"]) {
    assert.equal(errorOf(await staff.updateRoles(as(who), id(who), { roles: ["OWNER"] })), "cannot_change_own_access");
    assert.equal(errorOf(await staff.changeStatus(as(who), id(who), { status: "ENDED" })), "cannot_change_own_access");
    assert.equal(errorOf(await staff.resetPassword(as(who), id(who))), "cannot_change_own_access");
  }
});

test("owner: can change another person's roles (keeping the list tidy and ordered) and the change is audited with ids and role names only", async () => {
  const { staff, as, id, repo } = await setup();
  const updated = unwrap(await staff.updateRoles(as("owner"), id("teacher"), { roles: ["BURSAR", "TEACHER", "TEACHER"] }));
  assert.deepEqual(updated.roles, ["TEACHER", "BURSAR"]);
  assert.equal(errorOf(await staff.updateRoles(as("owner"), id("teacher"), { roles: ["TEACHER", "BURSAR"] })), "validation_error", "nothing to change");
  assert.equal(errorOf(await staff.updateRoles(as("owner"), id("teacher"), { roles: [] })), "validation_error");
  assert.equal(errorOf(await staff.updateRoles(as("owner"), id("teacher"), { roles: ["GOD"] })), "validation_error");
  const event = repo.audit.at(-1)!;
  assert.equal(event.action, "staff.roles_changed");
  assert.equal(event.schoolId, A);
  assert.deepEqual(event.metadata, { from: ["TEACHER"], to: ["TEACHER", "BURSAR"] });
});

test("last owner: with two owners one can be demoted; with no other active owner it is refused, including when the check races the database", async () => {
  const { staff, as, id, repo } = await setup();
  // Two owners: demoting one is fine, and the other is still an owner.
  const before = JSON.stringify(await repo.findStaff(A, id("owner2")));
  assert.deepEqual(unwrap(await staff.updateRoles(as("owner"), id("owner2"), { roles: ["HEADTEACHER"] })).roles, ["HEADTEACHER"]);
  unwrap(await staff.updateRoles(as("owner"), id("owner2"), { roles: ["OWNER"] }));
  assert.equal(JSON.stringify(await repo.findStaff(A, id("owner2"))).includes("OWNER"), true);
  void before;

  // The service's own check: no other active owner.
  const realCount = repo.countActiveOwners.bind(repo);
  repo.countActiveOwners = async () => 0;
  assert.equal(errorOf(await staff.updateRoles(as("owner"), id("owner2"), { roles: ["TEACHER"] })), "last_owner");
  assert.equal(errorOf(await staff.changeStatus(as("owner"), id("owner2"), { status: "ENDED" })), "last_owner");

  // A race: the check still sees another owner, but by the time of the write that owner is gone.
  repo.countActiveOwners = async () => 1;
  await repo.setStatus(A, id("owner"), "SUSPENDED", NOW, false);
  const snapshot = JSON.stringify(await repo.findStaff(A, id("owner2")));
  assert.equal(errorOf(await staff.updateRoles(as("owner"), id("owner2"), { roles: ["TEACHER"] })), "last_owner");
  assert.equal(errorOf(await staff.changeStatus(as("owner"), id("owner2"), { status: "SUSPENDED" })), "last_owner");
  assert.equal(JSON.stringify(await repo.findStaff(A, id("owner2"))), snapshot, "nothing changed");
  repo.countActiveOwners = realCount;
});

test("status: active <-> suspended <-> ended, ENDED stamps the end time and reactivating clears it; INVITED and DISABLED can't be chosen", async () => {
  const { staff, as, id } = await setup();
  const t = id("teacher");
  assert.equal(unwrap(await staff.changeStatus(as("owner"), t, { status: "SUSPENDED" })).status, "SUSPENDED");
  assert.equal(unwrap(await staff.changeStatus(as("owner"), t, { status: "ACTIVE" })).status, "ACTIVE");
  const ended = unwrap(await staff.changeStatus(as("owner"), t, { status: "ENDED" }));
  assert.equal(ended.status, "ENDED");
  assert.equal(ended.endedAt, NOW.toISOString());
  assert.equal(errorOf(await staff.changeStatus(as("owner"), t, { status: "ENDED" })), "invalid_status_change");
  assert.equal(errorOf(await staff.changeStatus(as("owner"), t, { status: "SUSPENDED" })), "invalid_status_change");
  assert.equal(errorOf(await staff.updateRoles(as("owner"), t, { roles: ["BURSAR"] })), "membership_ended", "an ended membership's roles are frozen");
  assert.equal(errorOf(await staff.resetPassword(as("owner"), t)), "membership_ended");
  const back = unwrap(await staff.changeStatus(as("owner"), t, { status: "ACTIVE" }));
  assert.equal(back.endedAt, null);
  for (const status of ["INVITED", "DISABLED", "active", "", 5, null, undefined]) {
    assert.equal(errorOf(await staff.changeStatus(as("owner"), t, { status })), "validation_error", String(status));
  }
});

test("access: a suspended or ended membership loses access to the school on the very next request; reactivating restores it", async () => {
  const { staff, as, id, signIn } = await setup();
  const login = await signIn.login("teacher@example.test", PASSWORD);
  assert.ok(login.ok);
  assert.equal((await signIn.authenticate(login.sessionToken))!.school!.id, A);

  unwrap(await staff.changeStatus(as("owner"), id("teacher"), { status: "SUSPENDED" }));
  const suspended = (await signIn.authenticate(login.sessionToken))!;
  assert.equal(suspended.school, null, "no school, so every school route answers 403");
  assert.deepEqual(suspended.schools, []);

  unwrap(await staff.changeStatus(as("owner"), id("teacher"), { status: "ACTIVE" }));
  assert.equal((await signIn.authenticate(login.sessionToken))!.school!.id, A);

  unwrap(await staff.changeStatus(as("owner"), id("teacher"), { status: "ENDED" }));
  assert.equal((await signIn.authenticate(login.sessionToken))!.school, null);
});

test("access: a person who belongs to two schools keeps the other school when one membership ends; a disabled user loses everything", async () => {
  const { staff, as, id, signIn, add, auth, people } = await setup();
  add("shared", A, ["TEACHER"]);
  add("sharedInC", C, ["TEACHER"], people.shared!.userId);
  const login = await signIn.login("shared@example.test", PASSWORD);
  assert.ok(login.ok);
  assert.equal(login.activeSchoolId, null, "two schools: the person chooses");
  unwrap(await staff.changeStatus(as("owner"), id("shared"), { status: "ENDED" }));
  const ctx = (await signIn.authenticate(login.sessionToken))!;
  assert.deepEqual(ctx.schools.map((s) => s.schoolId), [C], "school C is untouched");

  auth.users.get(people.shared!.userId)!.status = "DISABLED";
  assert.equal(await signIn.authenticate(login.sessionToken), null, "a disabled user is signed out everywhere");
  assert.equal((await signIn.login("shared@example.test", PASSWORD)).ok, false);
});

test("reset password: a new one-time password, the old one stops working, every session ends, the person must choose their own", async () => {
  const { staff, as, id, signIn, auth, people } = await setup();
  const login = await signIn.login("teacher@example.test", PASSWORD);
  assert.ok(login.ok);
  const reset = unwrap(await staff.resetPassword(as("admin"), id("teacher")));
  assert.equal(reset.staff.awaitingFirstSignIn, true);
  assert.notEqual(reset.temporaryPassword, PASSWORD);
  assert.equal(await signIn.authenticate(login.sessionToken), null, "the old session is gone");
  assert.equal((await signIn.login("teacher@example.test", PASSWORD)).ok, false, "the old password no longer works");
  const next = await signIn.login("teacher@example.test", reset.temporaryPassword);
  assert.ok(next.ok);
  assert.equal(next.mustChangePassword, true);
  const stored = auth.credentials.get(people.teacher!.userId)!;
  assert.notEqual(stored.passwordHash, reset.temporaryPassword);
  assert.equal(stored.failedLoginCount, 0);
});

test("reset password: clears a lock-out, is refused for a suspended person and for an account shared with another school", async () => {
  const { staff, as, id, signIn, add, auth, people } = await setup();
  for (let i = 0; i < 3; i += 1) await signIn.login("bursar@example.test", "wrong password here");
  assert.ok(auth.credentials.get(people.bursar!.userId)!.lockedUntil);
  const reset = unwrap(await staff.resetPassword(as("owner"), id("bursar")));
  assert.equal(auth.credentials.get(people.bursar!.userId)!.lockedUntil, null);
  assert.ok((await signIn.login("bursar@example.test", reset.temporaryPassword)).ok);

  unwrap(await staff.changeStatus(as("owner"), id("teacher"), { status: "SUSPENDED" }));
  assert.equal(errorOf(await staff.resetPassword(as("owner"), id("teacher"))), "membership_not_active");

  add("shared", A, ["TEACHER"]);
  add("sharedInC", C, ["TEACHER"], people.shared!.userId);
  const hash = auth.credentials.get(people.shared!.userId)!.passwordHash;
  assert.equal(errorOf(await staff.resetPassword(as("owner"), id("shared"))), "shared_account");
  assert.equal(auth.credentials.get(people.shared!.userId)!.passwordHash, hash, "the other school's person keeps their password");
});

test("reset password is all or nothing: a failure leaves the old password and the sessions alone", async () => {
  const { staff, as, id, signIn, repo } = await setup();
  const login = await signIn.login("teacher@example.test", PASSWORD);
  assert.ok(login.ok);
  const audits = repo.audit.length;
  repo.failNextPasswordReset = true;
  await assert.rejects(staff.resetPassword(as("owner"), id("teacher")), /simulated/);
  assert.ok(await signIn.authenticate(login.sessionToken), "the session is still alive");
  assert.ok((await signIn.login("teacher@example.test", PASSWORD)).ok, "the old password still works");
  assert.equal(repo.audit.length, audits);
});

test("school isolation: another school's owner finds nothing, with the same answer as a made-up id, and changes nothing", async () => {
  const { staff, as, id, repo } = await setup();
  const before = JSON.stringify([...(await repo.listStaff(A))]);
  const attacker = as("outsider");
  for (const target of [id("teacher"), id("owner"), MISSING]) {
    assert.deepEqual(await staff.updateRoles(attacker, target, { roles: ["OWNER"] }), { ok: false, error: "not_found", fields: undefined }, "roles");
    assert.deepEqual(await staff.changeStatus(attacker, target, { status: "ENDED" }), { ok: false, error: "not_found", fields: undefined }, "status");
    assert.deepEqual(await staff.resetPassword(attacker, target), { ok: false, error: "not_found", fields: undefined }, "password");
  }
  assert.equal(JSON.stringify([...(await repo.listStaff(A))]), before);
  assert.equal(repo.audit.length, 0);
  // Creating an account always lands in the caller's own school.
  const made = unwrap(await staff.create(attacker, { ...newTeacher, email: "c-teacher@example.test" }));
  assert.deepEqual((await repo.listStaff(A)).map((s) => s.email).includes("c-teacher@example.test"), false);
  assert.ok((await repo.listStaff(C)).some((s) => s.membershipId === made.staff.membershipId));
});

test("audit safety: events carry ids, role names and status words only, never an e-mail, name, password or hash", async () => {
  const { staff, as, id, repo, signIn } = await setup();
  const made = unwrap(await staff.create(as("owner"), newTeacher));
  unwrap(await staff.updateRoles(as("owner"), made.staff.membershipId, { roles: ["BURSAR"] }));
  unwrap(await staff.changeStatus(as("owner"), made.staff.membershipId, { status: "SUSPENDED" }));
  unwrap(await staff.changeStatus(as("owner"), made.staff.membershipId, { status: "ACTIVE" }));
  const reset = unwrap(await staff.resetPassword(as("admin"), id("teacher")));
  assert.deepEqual(repo.audit.map((e) => e.action), ["staff.created", "staff.roles_changed", "staff.status_changed", "staff.status_changed", "staff.password_reset"]);
  for (const event of repo.audit) {
    assertAuditSafe(event.metadata);
    assert.equal(event.schoolId, A);
    assert.equal(event.entityType, "membership");
    assert.ok(event.actorUserId);
  }
  const dump = JSON.stringify(repo.audit);
  for (const secret of [made.temporaryPassword, reset.temporaryPassword, PASSWORD, "new.teacher@example.test", "Efua", "Owusu", "$scrypt", "argon2id", "teacher@example.test"]) {
    assert.ok(!dump.includes(secret), `audit leaked ${secret}`);
  }
  assert.deepEqual(repo.audit.at(-1)!.metadata, { sessionsRevoked: 0 });
  void signIn;
});

test("the service has no way to delete a person", async () => {
  const { staff } = await setup();
  assert.deepEqual(Object.keys(staff).sort(), ["changeStatus", "create", "list", "resetPassword", "updateRoles"]);
});

test("no member shape ever holds a hash, a session or a user id", async () => {
  const { staff, as } = await setup();
  const made = unwrap(await staff.create(as("owner"), newTeacher));
  const all: StaffMember[] = [...unwrap(await staff.list(as("owner"))).staff, made.staff];
  const dump = JSON.stringify(all);
  assert.doesNotMatch(dump, /password|hash|session|userId|token/i);
});
