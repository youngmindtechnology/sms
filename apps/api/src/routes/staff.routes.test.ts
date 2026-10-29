import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { createAuthService } from "../auth/authService.js";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { RateLimiter } from "../http/rateLimiter.js";
import { createStaffService } from "../staff/staffService.js";
import { MemoryRepository } from "../testing/memoryRepository.js";
import { MemoryStaffRepository } from "../testing/memoryStaffRepository.js";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";
const SCHOOL_A = "10000000-0000-4000-8000-0000000000a1";
const SCHOOL_C = "10000000-0000-4000-8000-0000000000c1";
const MISSING = "70000000-0000-4000-8000-0000000000ff";
const config = loadConfig({ DATABASE_URL: "postgresql://app:SENTINEL-db-secret@localhost:5432/ymt_dev", FRONTEND_ORIGIN: ORIGIN });

type Role = "OWNER" | "HEADTEACHER" | "ADMINISTRATOR" | "TEACHER" | "BURSAR";

async function build() {
  const repo = new MemoryRepository();
  const fast = (password: string) => hashPassword(password, { algorithm: "scrypt", fast: true });
  const { hash, algorithm } = await fast(PASSWORD);
  const staffRepo = new MemoryStaffRepository(repo);
  const emails: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const add = (key: string, schoolId: string, schoolName: string, roles: Role[]) => {
    const email = `${key}@example.test`;
    const user = repo.addUser({ email, fullName: `Person ${key}`, status: "ACTIVE" }, { passwordHash: hash, algorithm });
    repo.addMembership(user.id, { schoolId, schoolName, schoolStatus: "ACTIVE", status: "ACTIVE", roles });
    emails[key] = email;
    ids[key] = repo.memberships.get(user.id)![0]!.membershipId;
  };
  add("owner", SCHOOL_A, "Alpha", ["OWNER"]);
  add("owner2", SCHOOL_A, "Alpha", ["OWNER"]);
  add("admin", SCHOOL_A, "Alpha", ["ADMINISTRATOR"]);
  add("head", SCHOOL_A, "Alpha", ["HEADTEACHER"]);
  add("teacher", SCHOOL_A, "Alpha", ["TEACHER"]);
  add("bursar", SCHOOL_A, "Alpha", ["BURSAR"]);
  add("outsider", SCHOOL_C, "Charlie", ["OWNER"]);
  add("outsiderTeacher", SCHOOL_C, "Charlie", ["TEACHER"]);

  const auth = createAuthService(repo, config);
  const app = createApp({
    config, auth,
    staff: createStaffService(staffRepo, { hash: fast }),
    authRoutes: { loginLimiter: new RateLimiter({ windowMs: 60_000, limit: 1000 }), passwordLimiter: new RateLimiter({ windowMs: 60_000, limit: 1000 }) },
  });
  async function signIn(email: string, password = PASSWORD) {
    const login = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email, password });
    assert.equal(login.status, 200, `login ${email}`);
    const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    const csrf = login.body.csrfToken as string;
    return {
      cookie, csrf, login,
      get: (path: string) => request(app).get(path).set("Cookie", cookie),
      send: (method: "post" | "patch" | "put" | "delete", path: string, body?: object) =>
        request(app)[method](path).set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", csrf).send(body ?? {}),
    };
  }
  const as = (key: string) => signIn(emails[key]!);
  return { app, repo, staffRepo, as, signIn, ids, emails };
}
const NEW = { email: "New.Teacher@Example.test", fullName: "Efua Owusu", roles: ["TEACHER"] };
const SECRETS = /temporaryPassword|passwordHash|password_hash|tokenHash|token_hash|csrf|\$scrypt|\$argon2/i;

test("every staff route needs a signed-in session (401)", async () => {
  const { app } = await build();
  const routes = [
    ["get", "/api/staff"], ["post", "/api/staff"], ["patch", `/api/staff/${MISSING}/roles`],
    ["post", `/api/staff/${MISSING}/status`], ["post", `/api/staff/${MISSING}/reset-password`],
  ] as const;
  for (const [method, path] of routes) assert.equal((await request(app)[method](path).set("Origin", ORIGIN)).status, 401, `${method} ${path}`);
});

test("permissions: only owner and administrator can use staff management; headteacher, teacher and bursar get 403 on every route and change nothing", async () => {
  const { as, ids, staffRepo, repo } = await build();
  const before = JSON.stringify([...await staffRepo.listStaff(SCHOOL_A)]);
  for (const who of ["head", "teacher", "bursar"]) {
    const person = await as(who);
    const probes: Array<[string, string, object?]> = [
      ["get", "/api/staff"], ["post", "/api/staff", NEW],
      ["patch", `/api/staff/${ids.teacher}/roles`, { roles: ["OWNER"] }],
      ["post", `/api/staff/${ids.teacher}/status`, { status: "ENDED" }],
      ["post", `/api/staff/${ids.teacher}/reset-password`],
    ];
    for (const [method, path, body] of probes) {
      const res = await (method === "get" ? person.get(path) : person.send(method as "post" | "patch", path, body));
      assert.equal(res.status, 403, `${who} ${method} ${path}`);
      assert.deepEqual(res.body, { error: "insufficient_permission" });
    }
  }
  assert.equal(JSON.stringify([...await staffRepo.listStaff(SCHOOL_A)]), before);
  assert.equal(repo.users.size, 8, "no account was created");
});

test("list: owner and administrator see this school's staff only, with the roles they may assign, and no secret fields", async () => {
  const { as } = await build();
  const owner = await as("owner");
  const res = await owner.get("/api/staff");
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.staff.length, 6);
  assert.deepEqual(res.body.assignableRoles, ["OWNER", "HEADTEACHER", "ADMINISTRATOR", "TEACHER", "BURSAR"]);
  assert.equal(res.body.staff.filter((s: { isYou: boolean }) => s.isYou).length, 1);
  assert.doesNotMatch(JSON.stringify(res.body), SECRETS);
  assert.doesNotMatch(JSON.stringify(res.body), /outsider/i, "school C's people are not listed");
  const admin = await as("admin");
  assert.deepEqual((await admin.get("/api/staff")).body.assignableRoles, ["TEACHER", "BURSAR"]);
});

test("create over HTTP: 201 with the one-time password in that response only, never cached, never in a later list; the person can sign in and must change it", async () => {
  const { as, signIn } = await build();
  const owner = await as("owner");
  const res = await owner.send("post", "/api/staff", NEW);
  assert.equal(res.status, 201);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body.staff.email, "new.teacher@example.test");
  assert.deepEqual(res.body.staff.roles, ["TEACHER"]);
  assert.match(res.body.temporaryPassword, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
  assert.equal(res.body.staff.awaitingFirstSignIn, true);
  assert.equal("userId" in res.body.staff, false);

  const later = await owner.get("/api/staff");
  assert.doesNotMatch(JSON.stringify(later.body), new RegExp(res.body.temporaryPassword));
  assert.equal(later.body.staff.find((s: { email: string }) => s.email === "new.teacher@example.test").awaitingFirstSignIn, true);

  const newcomer = await signIn("new.teacher@example.test", res.body.temporaryPassword);
  assert.equal(newcomer.login.body.mustChangePassword, true);
  // Until the password is replaced, only "who am I", change-password and logout work.
  assert.equal((await newcomer.get("/api/auth/me")).status, 200);
  assert.equal((await newcomer.get("/api/auth/me")).body.mustChangePassword, true);
  const blocked = await newcomer.get("/api/staff");
  assert.equal(blocked.status, 403);
  assert.deepEqual(blocked.body, { error: "password_change_required" });
  const switched = await newcomer.send("post", "/api/auth/switch-school", { schoolId: SCHOOL_A });
  assert.equal(switched.status, 403);
  assert.deepEqual(switched.body, { error: "password_change_required" });

  const changed = await newcomer.send("post", "/api/auth/change-password", { currentPassword: res.body.temporaryPassword, newPassword: "a brand new long passphrase 77" });
  assert.equal(changed.status, 204);
  assert.equal((await newcomer.get("/api/auth/me")).body.mustChangePassword, false);
  // A teacher still cannot use staff management, but it is now the permission that says no.
  assert.deepEqual((await newcomer.get("/api/staff")).body, { error: "insufficient_permission" });
});

test("validation: bad bodies are 400, unknown fields are refused (so a school id can't be smuggled in), and nothing is echoed back", async () => {
  const { as, repo } = await build();
  const owner = await as("owner");
  const users = repo.users.size;
  const bad: object[] = [
    {}, { ...NEW, email: "nope" }, { ...NEW, fullName: "" }, { ...NEW, roles: [] }, { ...NEW, roles: ["GOD"] },
    { ...NEW, roles: "TEACHER" }, { ...NEW, schoolId: SCHOOL_C }, { ...NEW, school_id: SCHOOL_C }, { ...NEW, status: "ACTIVE" },
    { ...NEW, password: "chosen-by-client-1" }, { ...NEW, userId: MISSING },
  ];
  for (const body of bad) {
    const res = await owner.send("post", "/api/staff", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.doesNotMatch(JSON.stringify(res.body), /chosen-by-client|SENTINEL|nope/);
  }
  assert.equal(repo.users.size, users);
  assert.equal((await owner.send("patch", "/api/staff/not-a-uuid/roles", { roles: ["TEACHER"] })).status, 400);
  assert.equal((await owner.send("patch", `/api/staff/${MISSING}/roles`, { roles: ["TEACHER"], schoolId: SCHOOL_C })).status, 400);
  assert.equal((await owner.send("post", `/api/staff/${MISSING}/status`, { status: "ENDED", userId: MISSING })).status, 400);
  assert.equal((await owner.get(`/api/staff?schoolId=${SCHOOL_C}`)).body.staff.length, 6, "a school id in the query string is ignored");
});

test("a duplicate e-mail is 409 with the same body whether it is used in this school or another", async () => {
  const { as } = await build();
  const owner = await as("owner");
  const same = await owner.send("post", "/api/staff", { ...NEW, email: "teacher@example.test" });
  const other = await owner.send("post", "/api/staff", { ...NEW, email: "outsider@example.test" });
  assert.equal(same.status, 409);
  assert.deepEqual(same.body, other.body);
});

test("escalation over HTTP: an administrator can't create or promote to administrator/headteacher/owner, can't touch them, and nobody can change themselves", async () => {
  const { as, ids } = await build();
  const admin = await as("admin");
  for (const roles of [["OWNER"], ["HEADTEACHER"], ["ADMINISTRATOR"], ["TEACHER", "OWNER"]]) {
    const res = await admin.send("post", "/api/staff", { ...NEW, email: `${roles.join("")}@x.test`, roles });
    assert.equal(res.status, 403, roles.join());
    assert.equal(res.body.error, "role_not_allowed");
  }
  assert.equal((await admin.send("post", "/api/staff", { ...NEW, email: "ok@x.test", roles: ["BURSAR"] })).status, 201);
  assert.equal((await admin.send("patch", `/api/staff/${ids.teacher}/roles`, { roles: ["ADMINISTRATOR"] })).status, 403);
  for (const victim of ["owner", "owner2", "head"]) {
    assert.equal((await admin.send("patch", `/api/staff/${ids[victim]}/roles`, { roles: ["TEACHER"] })).status, 403, victim);
    assert.equal((await admin.send("post", `/api/staff/${ids[victim]}/status`, { status: "SUSPENDED" })).status, 403, victim);
    assert.equal((await admin.send("post", `/api/staff/${ids[victim]}/reset-password`)).status, 403, victim);
  }
  assert.equal((await admin.send("patch", `/api/staff/${ids.admin}/roles`, { roles: ["OWNER"] })).body.error, "cannot_change_own_access");
  const owner = await as("owner");
  assert.equal((await owner.send("post", `/api/staff/${ids.owner}/status`, { status: "ENDED" })).body.error, "cannot_change_own_access");
  assert.equal((await owner.get("/api/staff")).body.staff.find((s: { membershipId: string }) => s.membershipId === ids.admin).roles[0], "ADMINISTRATOR", "nothing changed");
});

test("role and status changes over HTTP: the roles update, and a suspended or ended person is locked out of the school on their very next request", async () => {
  const { as, ids } = await build();
  const owner = await as("owner");
  const teacher = await as("teacher");
  assert.equal((await teacher.get("/api/auth/me")).body.school.id, SCHOOL_A);

  const roles = await owner.send("patch", `/api/staff/${ids.teacher}/roles`, { roles: ["TEACHER", "BURSAR"] });
  assert.equal(roles.status, 200);
  assert.deepEqual(roles.body.roles, ["TEACHER", "BURSAR"]);
  assert.deepEqual((await teacher.get("/api/auth/me")).body.school.roles.slice().sort(), ["BURSAR", "TEACHER"], "the new roles apply on the next request");

  const suspended = await owner.send("post", `/api/staff/${ids.teacher}/status`, { status: "SUSPENDED" });
  assert.equal(suspended.body.status, "SUSPENDED");
  const me = await teacher.get("/api/auth/me");
  assert.equal(me.status, 200, "the person is still signed in");
  assert.equal(me.body.school, null, "but has no school");
  assert.equal((await teacher.get("/api/staff")).body.error, "school_required");

  assert.equal((await owner.send("post", `/api/staff/${ids.teacher}/status`, { status: "ACTIVE" })).body.status, "ACTIVE");
  assert.equal((await teacher.get("/api/auth/me")).body.school.id, SCHOOL_A);
  const ended = await owner.send("post", `/api/staff/${ids.teacher}/status`, { status: "ENDED" });
  assert.equal(ended.body.status, "ENDED");
  assert.ok(ended.body.endedAt);
  assert.equal((await teacher.get("/api/auth/me")).body.school, null);
  assert.equal((await owner.send("post", `/api/staff/${ids.teacher}/status`, { status: "INVITED" })).status, 400);
  assert.equal((await owner.send("post", `/api/staff/${ids.teacher}/status`, { status: "ENDED" })).status, 409);
});

test("reset password over HTTP: a new one-time password, the old session and password stop working, the person must choose a new one", async () => {
  const { app, as, ids, signIn } = await build();
  const owner = await as("owner");
  const teacher = await as("teacher");
  const res = await owner.send("post", `/api/staff/${ids.teacher}/reset-password`);
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.body.temporaryPassword, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
  assert.equal((await teacher.get("/api/auth/me")).status, 401, "the old session is revoked");
  assert.equal((await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: "teacher@example.test", password: PASSWORD })).status, 401, "the old password no longer works");
  const again = await signIn("teacher@example.test", res.body.temporaryPassword);
  assert.equal(again.login.body.mustChangePassword, true);
});

test("school isolation over HTTP: another school's owner gets 404, identical to a made-up id, for every membership route, and changes nothing", async () => {
  const { as, ids, staffRepo } = await build();
  const before = JSON.stringify([...await staffRepo.listStaff(SCHOOL_A)]);
  const attacker = await as("outsider");
  for (const target of [ids.teacher, ids.owner, ids.admin, MISSING]) {
    for (const [method, path, body] of [
      ["patch", `/api/staff/${target}/roles`, { roles: ["OWNER"] }],
      ["post", `/api/staff/${target}/status`, { status: "ENDED" }],
      ["post", `/api/staff/${target}/reset-password`, {}],
    ] as const) {
      const res = await attacker.send(method, path, body);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.deepEqual(res.body, { error: "not_found" });
    }
  }
  assert.equal(JSON.stringify([...await staffRepo.listStaff(SCHOOL_A)]), before);
  assert.equal(staffRepo.audit.length, 0, "no staff audit event for changes that did not happen");
  // The attacker's own list and creations stay in their own school.
  assert.deepEqual((await attacker.get("/api/staff")).body.staff.map((s: { email: string }) => s.email).sort(), ["outsider@example.test", "outsiderTeacher@example.test"]);
  const made = await attacker.send("post", "/api/staff", { ...NEW, email: "c@example.test" });
  assert.equal(made.status, 201);
  assert.equal((await staffRepo.listStaff(SCHOOL_A)).some((s) => s.email === "c@example.test"), false);
});

test("state-changing staff calls need the trusted Origin and the CSRF token", async () => {
  const { app, as, ids } = await build();
  const owner = await as("owner");
  const calls: Array<["post" | "patch", string, object]> = [
    ["post", "/api/staff", NEW], ["patch", `/api/staff/${ids.teacher}/roles`, { roles: ["BURSAR"] }],
    ["post", `/api/staff/${ids.teacher}/status`, { status: "ENDED" }], ["post", `/api/staff/${ids.teacher}/reset-password`, {}],
  ];
  for (const [method, path, body] of calls) {
    const noCsrf = await request(app)[method](path).set("Cookie", owner.cookie).set("Origin", ORIGIN).send(body);
    assert.equal(noCsrf.status, 403, `${path} without csrf`);
    assert.equal(noCsrf.body.error, "bad_csrf");
    const badOrigin = await request(app)[method](path).set("Cookie", owner.cookie).set("Origin", "http://evil.example").set("X-CSRF-Token", owner.csrf).send(body);
    assert.equal(badOrigin.status, 403, `${path} from another origin`);
    assert.equal(badOrigin.body.error, "bad_origin");
  }
  assert.equal((await owner.get("/api/staff")).body.staff.find((s: { membershipId: string }) => s.membershipId === ids.teacher).status, "ACTIVE");
});

test("there is no way to delete a person", async () => {
  const { as, ids } = await build();
  const owner = await as("owner");
  for (const path of ["/api/staff", `/api/staff/${ids.teacher}`, `/api/staff/${ids.teacher}/roles`]) {
    assert.ok([404, 405].includes((await owner.send("delete", path)).status), path);
  }
  assert.equal((await owner.get("/api/staff")).body.staff.length, 6);
});

test("audit hygiene: after create, role, status and reset no audit event holds an e-mail, name, password or hash", async () => {
  const { as, ids, staffRepo } = await build();
  const owner = await as("owner");
  const made = await owner.send("post", "/api/staff", NEW);
  await owner.send("patch", `/api/staff/${made.body.staff.membershipId}/roles`, { roles: ["BURSAR"] });
  await owner.send("post", `/api/staff/${made.body.staff.membershipId}/status`, { status: "SUSPENDED" });
  const reset = await owner.send("post", `/api/staff/${ids.bursar}/reset-password`);
  const events = staffRepo.audit;
  assert.deepEqual(events.map((e) => e.action), ["staff.created", "staff.roles_changed", "staff.status_changed", "staff.password_reset"]);
  const dump = JSON.stringify(events);
  for (const secret of [made.body.temporaryPassword, reset.body.temporaryPassword, PASSWORD, "new.teacher@example.test", "Efua", "Owusu", "bursar@example.test", "$scrypt"]) {
    assert.ok(!dump.includes(secret), `audit leaked ${secret}`);
  }
  for (const e of events) assert.equal(e.schoolId, SCHOOL_A);
});

test("a database failure is an opaque 500: no message, no secret", async () => {
  const { as, staffRepo } = await build();
  const owner = await as("owner");
  staffRepo.listStaff = async () => { throw new Error("connection to SENTINEL-db-secret failed"); };
  const res = await owner.get("/api/staff");
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "internal_error" });
});

test("an ended membership or a suspended person can no longer manage staff on the very next request", async () => {
  const { as, ids } = await build();
  const owner = await as("owner");
  const admin = await as("admin");
  assert.equal((await admin.get("/api/staff")).status, 200);
  assert.equal((await owner.send("post", `/api/staff/${ids.admin}/status`, { status: "SUSPENDED" })).status, 200);
  const res = await admin.get("/api/staff");
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "school_required");
});
