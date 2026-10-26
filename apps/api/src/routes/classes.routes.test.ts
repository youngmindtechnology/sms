import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { createAuthService } from "../auth/authService.js";
import { hashPassword } from "../auth/password.js";
import { createClassService } from "../classes/classService.js";
import { loadConfig } from "../config.js";
import { RateLimiter } from "../http/rateLimiter.js";
import { MemoryClassRepository } from "../testing/memoryClassRepository.js";
import { MemoryRepository } from "../testing/memoryRepository.js";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";
const SCHOOL_A = "10000000-0000-4000-8000-0000000000a1";
const SCHOOL_C = "10000000-0000-4000-8000-0000000000c1";
const MISSING = "40000000-0000-4000-8000-0000000000ff";
const config = loadConfig({ DATABASE_URL: "postgresql://app:SENTINEL-db-secret@localhost:5432/ymt_dev", FRONTEND_ORIGIN: ORIGIN });

type Role = "OWNER" | "HEADTEACHER" | "ADMINISTRATOR" | "TEACHER" | "BURSAR";

async function build() {
  const repo = new MemoryRepository();
  const classRepo = new MemoryClassRepository();
  const { hash, algorithm } = await hashPassword(PASSWORD, { algorithm: "scrypt", fast: true });
  const emails: Record<string, string> = {};
  const add = (key: string, schoolId: string, schoolName: string, roles: Role[]) => {
    const email = `${key}@example.test`;
    const user = repo.addUser({ email, fullName: key, status: "ACTIVE" }, { passwordHash: hash, algorithm });
    repo.addMembership(user.id, { schoolId, schoolName, schoolStatus: "ACTIVE", status: "ACTIVE", roles });
    emails[key] = email;
  };
  add("owner", SCHOOL_A, "Alpha", ["OWNER"]);
  add("head", SCHOOL_A, "Alpha", ["HEADTEACHER"]);
  add("admin", SCHOOL_A, "Alpha", ["ADMINISTRATOR"]);
  add("teacher", SCHOOL_A, "Alpha", ["TEACHER"]);
  add("bursar", SCHOOL_A, "Alpha", ["BURSAR"]);
  add("outsider", SCHOOL_C, "Charlie", ["OWNER"]);
  const auth = createAuthService(repo, config);
  const app = createApp({
    config, auth, classes: createClassService(classRepo),
    authRoutes: { loginLimiter: new RateLimiter({ windowMs: 60_000, limit: 1000 }) },
  });
  async function as(key: string) {
    const login = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: emails[key], password: PASSWORD });
    assert.equal(login.status, 200);
    const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    const csrf = login.body.csrfToken as string;
    return {
      cookie, csrf,
      get: (path: string) => request(app).get(path).set("Cookie", cookie),
      send: (method: "post" | "patch" | "put" | "delete", path: string, body?: object) =>
        request(app)[method](path).set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", csrf).send(body ?? {}),
    };
  }
  return { app, repo, classRepo, as };
}

test("every classes route needs a signed-in session (401)", async () => {
  const { app } = await build();
  for (const [method, path] of [["get", "/api/classes"], ["post", "/api/classes"], ["put", "/api/classes/order"], ["patch", `/api/classes/${MISSING}`]] as const) {
    assert.equal((await request(app)[method](path).set("Origin", ORIGIN)).status, 401, `${method} ${path}`);
  }
});

test("owner: creates, lists in order, edits, deactivates, reactivates and reorders", async () => {
  const { as, classRepo } = await build();
  const owner = await as("owner");
  assert.deepEqual((await owner.get("/api/classes")).body, { classes: [] });

  const n1 = await owner.send("post", "/api/classes", { name: "Nursery 1", level: "NURSERY" });
  assert.equal(n1.status, 201);
  assert.equal(n1.headers["cache-control"], "no-store");
  const kg = await owner.send("post", "/api/classes", { name: "KG 1", level: "KINDERGARTEN", sortOrder: 5 });
  const b1 = await owner.send("post", "/api/classes", { name: "Basic 1A", level: "PRIMARY", sortOrder: 9 });
  assert.deepEqual((await owner.get("/api/classes")).body.classes.map((c: { name: string }) => c.name), ["Nursery 1", "KG 1", "Basic 1A"]);

  assert.equal((await owner.send("patch", `/api/classes/${b1.body.id}`, { name: "Basic 2A", level: "PRIMARY" })).body.name, "Basic 2A");
  const off = await owner.send("patch", `/api/classes/${kg.body.id}`, { isActive: false });
  assert.equal(off.body.isActive, false);
  assert.equal(off.body.id, kg.body.id);
  assert.equal((await owner.get("/api/classes")).body.classes.length, 3, "inactive classes are still listed");
  assert.equal((await owner.send("patch", `/api/classes/${kg.body.id}`, { isActive: true })).body.isActive, true);

  const reorder = await owner.send("put", "/api/classes/order", { classIds: [b1.body.id, kg.body.id, n1.body.id] });
  assert.equal(reorder.status, 200);
  assert.deepEqual(reorder.body.classes.map((c: { name: string; sortOrder: number }) => [c.name, c.sortOrder]), [["Basic 2A", 1], ["KG 1", 2], ["Nursery 1", 3]]);
  assert.ok(classRepo.rows.every((r) => r.schoolId === SCHOOL_A), "saved in the session's school");
});

test("validation: bad levels, orders and names are 400 with field messages; duplicates and stale orders are 409", async () => {
  const { as } = await build();
  const owner = await as("owner");
  const bad = await owner.send("post", "/api/classes", { name: "Basic 1", level: "SENIOR" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "validation_error");
  assert.ok(bad.body.fields.level);
  assert.equal((await owner.send("post", "/api/classes", { name: "Basic 1", level: "PRIMARY", sortOrder: -3 })).body.fields.sortOrder.length > 0, true);
  assert.equal((await owner.send("post", "/api/classes", { name: "", level: "PRIMARY" })).status, 400);
  assert.equal((await owner.send("post", "/api/classes", { name: "Basic 1", level: "PRIMARY", sortOrder: "3" })).status, 400, "wrong type");
  const first = await owner.send("post", "/api/classes", { name: "Basic 1A", level: "PRIMARY" });
  const dup = await owner.send("post", "/api/classes", { name: "BASIC 1A", level: "PRIMARY" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "duplicate_name");
  assert.equal((await owner.send("put", "/api/classes/order", { classIds: [MISSING] })).status, 409);
  assert.equal((await owner.send("put", "/api/classes/order", { classIds: [first.body.id, first.body.id] })).status, 400);
  assert.equal((await owner.send("put", "/api/classes/order", {})).status, 400);
});

test("permissions: owner, headteacher and administrator manage; teacher and bursar can read but not write", async () => {
  const { as } = await build();
  for (const [who, name] of [["head", "Head class"], ["admin", "Admin class"]] as const) {
    assert.equal((await (await as(who)).send("post", "/api/classes", { name, level: "JHS" })).status, 201, who);
  }
  for (const who of ["teacher", "bursar"] as const) {
    const person = await as(who);
    assert.equal((await person.get("/api/classes")).status, 200, `${who} can read`);
    const list = (await person.get("/api/classes")).body.classes as Array<{ id: string }>;
    const denied = await person.send("post", "/api/classes", { name: "Sneaky", level: "JHS" });
    assert.equal(denied.status, 403, who);
    assert.equal(denied.body.error, "insufficient_permission");
    assert.equal((await person.send("patch", `/api/classes/${list[0]!.id}`, { name: "Hacked" })).status, 403);
    assert.equal((await person.send("put", "/api/classes/order", { classIds: list.map((c) => c.id) })).status, 403);
    assert.equal((await person.get("/api/classes")).body.classes.length, 2, "nothing changed");
  }
});

test("no delete is exposed: DELETE is not a route and the class survives", async () => {
  const { as, classRepo } = await build();
  const owner = await as("owner");
  const c = await owner.send("post", "/api/classes", { name: "Basic 1A", level: "PRIMARY" });
  for (const path of [`/api/classes/${c.body.id}`, "/api/classes"]) {
    const res = await owner.send("delete", path);
    assert.ok([404, 405].includes(res.status), `DELETE ${path} -> ${res.status}`);
  }
  assert.equal(classRepo.rows.length, 1);
  assert.equal(classRepo.rows[0]!.id, c.body.id);
});

test("tenant isolation: another school's owner cannot read or change classes, even with exact ids", async () => {
  const { as, classRepo } = await build();
  const owner = await as("owner");
  const c = await owner.send("post", "/api/classes", { name: "Basic 1A", level: "PRIMARY" });
  const before = JSON.stringify(classRepo.rows);
  const outsider = await as("outsider");
  assert.deepEqual((await outsider.get("/api/classes")).body, { classes: [] });
  const patch = await outsider.send("patch", `/api/classes/${c.body.id}`, { name: "Hacked", isActive: false });
  assert.equal(patch.status, 404);
  assert.deepEqual(patch.body, { error: "not_found" }, "same answer as an id that does not exist");
  assert.equal((await outsider.send("patch", `/api/classes/${MISSING}`, { name: "Hacked" })).status, 404);
  assert.equal((await outsider.send("put", "/api/classes/order", { classIds: [c.body.id] })).status, 409);
  assert.equal(JSON.stringify(classRepo.rows), before);
});

test("a school id from the client is never used", async () => {
  const { as, classRepo } = await build();
  const outsider = await as("outsider");
  assert.equal((await outsider.send("post", "/api/classes", { name: "X", level: "JHS", schoolId: SCHOOL_A })).status, 400, "unknown field refused");
  assert.equal(classRepo.rows.length, 0);
  assert.equal((await outsider.send("post", `/api/classes?schoolId=${SCHOOL_A}`, { name: "X", level: "JHS" })).status, 201);
  assert.equal(classRepo.rows[0]!.schoolId, SCHOOL_C, "saved in the session's school, not the query's");
});

test("state-changing calls need the trusted Origin and the CSRF token", async () => {
  const { app, as, classRepo } = await build();
  const owner = await as("owner");
  const attempt = (headers: Record<string, string>) => request(app).post("/api/classes").set("Cookie", owner.cookie).set(headers).send({ name: "X", level: "JHS" });
  assert.equal((await attempt({ "X-CSRF-Token": owner.csrf })).status, 403);
  assert.equal((await attempt({ Origin: ORIGIN })).status, 403);
  assert.equal((await attempt({ Origin: "http://evil.test", "X-CSRF-Token": owner.csrf })).status, 403);
  assert.equal(classRepo.rows.length, 0);
});

test("malformed ids and bodies are 400 and are not echoed back", async () => {
  const { as } = await build();
  const owner = await as("owner");
  assert.equal((await owner.send("patch", "/api/classes/not-a-uuid", { name: "x" })).status, 400);
  const bad = await owner.send("post", "/api/classes", { name: ["a"], level: 1, extra: "<script>alert(1)</script>" });
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(bad.body).includes("script"));
});

test("an ended membership or a suspended school loses access on the very next request", async () => {
  const { as, repo } = await build();
  const owner = await as("owner");
  assert.equal((await owner.get("/api/classes")).status, 200);
  const userId = [...repo.users.values()].find((u) => u.email === "owner@example.test")!.id;
  repo.memberships.get(userId)![0]!.status = "ENDED";
  assert.equal((await owner.get("/api/classes")).status, 403);
  assert.equal((await owner.send("post", "/api/classes", { name: "X", level: "JHS" })).status, 403);
  repo.memberships.get(userId)![0]!.status = "ACTIVE";
  assert.equal((await owner.get("/api/classes")).status, 200);
  repo.memberships.get(userId)![0]!.schoolStatus = "SUSPENDED";
  assert.equal((await owner.get("/api/classes")).status, 403);
});

test("a database failure is an opaque 500: no message, no secret", async () => {
  const { as, classRepo } = await build();
  const owner = await as("owner");
  classRepo.createClass = async () => { throw new Error("password=SENTINEL-db-secret connection lost"); };
  const res = await owner.send("post", "/api/classes", { name: "X", level: "JHS" });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "internal_error" });
  assert.ok(!JSON.stringify(res.body).includes("SENTINEL"));
});
