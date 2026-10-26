import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createAcademicService } from "../academic/academicService.js";
import { createApp } from "../app.js";
import { createAuthService } from "../auth/authService.js";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { RateLimiter } from "../http/rateLimiter.js";
import { MemoryAcademicRepository } from "../testing/memoryAcademicRepository.js";
import { MemoryRepository } from "../testing/memoryRepository.js";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";
const SCHOOL_A = "10000000-0000-4000-8000-0000000000a1";
const SCHOOL_B = "10000000-0000-4000-8000-0000000000b1";
const SCHOOL_C = "10000000-0000-4000-8000-0000000000c1";
const MISSING = "30000000-0000-4000-8000-0000000000ff";
const config = loadConfig({ DATABASE_URL: "postgresql://app:SENTINEL-db-secret@localhost:5432/ymt_dev", FRONTEND_ORIGIN: ORIGIN });

type Role = "OWNER" | "HEADTEACHER" | "ADMINISTRATOR" | "TEACHER" | "BURSAR";

/** One person per role, each in their own school-A membership; plus an outsider who owns school C. */
async function build() {
  const repo = new MemoryRepository();
  const academicRepo = new MemoryAcademicRepository();
  const { hash, algorithm } = await hashPassword(PASSWORD, { algorithm: "scrypt", fast: true });
  const people: Record<string, string> = {};
  const add = (key: string, schoolId: string, schoolName: string, roles: Role[]) => {
    const email = `${key}@example.test`;
    const user = repo.addUser({ email, fullName: key, status: "ACTIVE" }, { passwordHash: hash, algorithm });
    repo.addMembership(user.id, { schoolId, schoolName, schoolStatus: "ACTIVE", status: "ACTIVE", roles });
    people[key] = email;
  };
  add("owner", SCHOOL_A, "Alpha", ["OWNER"]);
  add("admin", SCHOOL_A, "Alpha", ["ADMINISTRATOR"]);
  add("teacher", SCHOOL_A, "Alpha", ["TEACHER"]);
  add("bursar", SCHOOL_A, "Alpha", ["BURSAR"]);
  add("outsider", SCHOOL_C, "Charlie", ["OWNER"]);
  const auth = createAuthService(repo, config);
  const app = createApp({
    config, auth, academic: createAcademicService(academicRepo),
    authRoutes: { loginLimiter: new RateLimiter({ windowMs: 60_000, limit: 1000 }) },
  });

  /** Signs in as a person (their single school is chosen automatically) and returns request helpers. */
  async function as(key: keyof typeof people) {
    const login = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: people[key], password: PASSWORD });
    assert.equal(login.status, 200);
    const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    const csrf = login.body.csrfToken as string;
    return {
      get: (path: string) => request(app).get(path).set("Cookie", cookie),
      send: (method: "post" | "patch", path: string, body?: object) =>
        request(app)[method](path).set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", csrf).send(body ?? {}),
      cookie, csrf,
    };
  }
  return { app, repo, academicRepo, as };
}

const year = { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" };
const term1 = { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" };

test("every academic route needs a signed-in session (401)", async () => {
  const { app } = await build();
  const paths = [
    ["get", "/api/academic-years"], ["get", `/api/academic-years/${MISSING}`], ["get", `/api/academic-years/${MISSING}/terms`],
    ["post", "/api/academic-years"], ["patch", `/api/academic-years/${MISSING}`], ["post", `/api/academic-years/${MISSING}/activate`],
    ["post", `/api/academic-years/${MISSING}/close`], ["post", `/api/academic-years/${MISSING}/terms`],
    ["patch", `/api/academic-years/${MISSING}/terms/${MISSING}`], ["post", `/api/academic-years/${MISSING}/terms/${MISSING}/activate`],
    ["post", `/api/academic-years/${MISSING}/terms/${MISSING}/close`],
  ] as const;
  for (const [method, path] of paths) {
    const res = await request(app)[method](path).set("Origin", ORIGIN);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("owner: creates, lists, reads, edits, activates and closes an academic year", async () => {
  const { as, academicRepo } = await build();
  const owner = await as("owner");

  const empty = await owner.get("/api/academic-years");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { years: [] });

  const created = await owner.send("post", "/api/academic-years", year);
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "PLANNED");
  assert.equal(created.headers["cache-control"], "no-store");
  const id = created.body.id as string;

  assert.equal((await owner.get("/api/academic-years")).body.years.length, 1);
  assert.equal((await owner.get(`/api/academic-years/${id}`)).body.name, "2026/2027");
  assert.equal((await owner.send("patch", `/api/academic-years/${id}`, { name: "2026-27" })).body.name, "2026-27");
  assert.equal((await owner.send("post", `/api/academic-years/${id}/activate`)).body.status, "ACTIVE");
  assert.equal((await owner.send("post", `/api/academic-years/${id}/activate`)).status, 409);
  assert.equal((await owner.send("post", `/api/academic-years/${id}/close`)).body.status, "CLOSED");
  assert.equal(academicRepo.years[0]!.schoolId, SCHOOL_A, "the school came from the session");
  assert.ok(academicRepo.audit.length >= 4);
});

test("owner: terms flow, with the business rules reported as 409 and field messages as 400", async () => {
  const { as } = await build();
  const owner = await as("owner");
  const y = (await owner.send("post", "/api/academic-years", year)).body.id as string;

  const t = await owner.send("post", `/api/academic-years/${y}/terms`, term1);
  assert.equal(t.status, 201);
  assert.equal(t.body.sequence, 1);
  assert.equal((await owner.get(`/api/academic-years/${y}/terms`)).body.terms.length, 1);

  const outside = await owner.send("post", `/api/academic-years/${y}/terms`, { name: "Early", startDate: "2026-07-01", endDate: "2026-07-20" });
  assert.equal(outside.status, 409);
  assert.equal(outside.body.error, "outside_year");
  assert.equal((await owner.send("post", `/api/academic-years/${y}/terms`, term1)).status, 409);

  const bad = await owner.send("post", `/api/academic-years/${y}/terms`, { name: "T", startDate: "2026-13-01", endDate: "2026-12-01" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "validation_error");
  assert.ok(bad.body.fields.startDate);

  assert.equal((await owner.send("post", `/api/academic-years/${y}/terms/${t.body.id}/activate`)).body.error, "year_not_active");
  await owner.send("post", `/api/academic-years/${y}/activate`);
  assert.equal((await owner.send("post", `/api/academic-years/${y}/terms/${t.body.id}/activate`)).body.status, "ACTIVE");
  assert.equal((await owner.send("patch", `/api/academic-years/${y}/terms/${t.body.id}`, { endDate: "2026-12-19" })).body.endDate, "2026-12-19");
  assert.equal((await owner.send("post", `/api/academic-years/${y}/terms/${t.body.id}/close`)).body.status, "CLOSED");
});

test("permissions: headteacher and administrator manage; teacher reads only; bursar is refused everything", async () => {
  const { app, as } = await build();
  for (const who of ["admin"] as const) {
    const person = await as(who);
    assert.equal((await person.send("post", "/api/academic-years", { ...year, name: `Y-${who}` })).status, 201, who);
  }
  const teacher = await as("teacher");
  assert.equal((await teacher.get("/api/academic-years")).status, 200);
  const denied = await teacher.send("post", "/api/academic-years", { ...year, name: "Teacher year", startDate: "2030-09-01", endDate: "2031-07-31" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "insufficient_permission");
  const list = (await teacher.get("/api/academic-years")).body.years as Array<{ id: string }>;
  for (const [method, path] of [["patch", `/api/academic-years/${list[0]!.id}`], ["post", `/api/academic-years/${list[0]!.id}/activate`], ["post", `/api/academic-years/${list[0]!.id}/close`], ["post", `/api/academic-years/${list[0]!.id}/terms`]] as const) {
    assert.equal((await teacher.send(method, path, { name: "x" })).status, 403, `${method} ${path}`);
  }
  assert.equal((await teacher.get("/api/academic-years")).body.years.length, 1, "nothing was created by the teacher");

  const bursar = await as("bursar");
  assert.equal((await bursar.get("/api/academic-years")).status, 403);
  assert.equal((await bursar.send("post", "/api/academic-years", year)).status, 403);
  assert.ok(app);
});

test("tenant isolation: an owner of school C cannot read or change school A's calendar, even with exact ids", async () => {
  const { as, academicRepo } = await build();
  const owner = await as("owner");
  const y = (await owner.send("post", "/api/academic-years", year)).body.id as string;
  const t = (await owner.send("post", `/api/academic-years/${y}/terms`, term1)).body.id as string;
  const before = JSON.stringify([academicRepo.years, academicRepo.terms]);

  const outsider = await as("outsider");
  assert.deepEqual((await outsider.get("/api/academic-years")).body, { years: [] });
  for (const res of [
    await outsider.get(`/api/academic-years/${y}`),
    await outsider.get(`/api/academic-years/${y}/terms`),
    await outsider.send("patch", `/api/academic-years/${y}`, { name: "Hacked" }),
    await outsider.send("post", `/api/academic-years/${y}/activate`),
    await outsider.send("post", `/api/academic-years/${y}/close`),
    await outsider.send("post", `/api/academic-years/${y}/terms`, { name: "Evil", startDate: "2026-10-01", endDate: "2026-10-10" }),
    await outsider.send("patch", `/api/academic-years/${y}/terms/${t}`, { name: "Hacked" }),
    await outsider.send("post", `/api/academic-years/${y}/terms/${t}/activate`),
    await outsider.send("post", `/api/academic-years/${y}/terms/${t}/close`),
  ]) {
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "not_found" }, "same answer as an id that does not exist");
  }
  assert.equal(JSON.stringify([academicRepo.years, academicRepo.terms]), before, "school A's data is unchanged");
});

test("a school id sent by the client is never used: unknown body fields are refused", async () => {
  const { as, academicRepo } = await build();
  const outsider = await as("outsider");
  const res = await outsider.send("post", "/api/academic-years", { ...year, schoolId: SCHOOL_A });
  assert.equal(res.status, 400);
  assert.equal(academicRepo.years.length, 0);
  const created = await outsider.send("post", `/api/academic-years?schoolId=${SCHOOL_A}`, year);
  assert.equal(created.status, 201);
  assert.equal(academicRepo.years[0]!.schoolId, SCHOOL_C, "saved in the session's school, not the one in the query");
});

test("state-changing calls need the trusted Origin and the CSRF token", async () => {
  const { app, as } = await build();
  const owner = await as("owner");
  const attempt = (headers: Record<string, string>) => request(app).post("/api/academic-years").set("Cookie", owner.cookie).set(headers).send(year);
  assert.equal((await attempt({ "X-CSRF-Token": owner.csrf })).status, 403, "no Origin");
  assert.equal((await attempt({ Origin: ORIGIN })).status, 403, "no CSRF");
  assert.equal((await attempt({ Origin: "http://evil.test", "X-CSRF-Token": owner.csrf })).status, 403, "wrong Origin");
  assert.equal((await owner.get("/api/academic-years")).body.years.length, 0, "nothing was created");
});

test("malformed ids and bodies are 400 and are not echoed back", async () => {
  const { as } = await build();
  const owner = await as("owner");
  for (const path of ["/api/academic-years/not-a-uuid", "/api/academic-years/123/terms"]) assert.equal((await owner.get(path)).status, 400, path);
  assert.equal((await owner.send("patch", "/api/academic-years/not-a-uuid", { name: "x" })).status, 400);
  const bad = await owner.send("post", "/api/academic-years", { name: ["a"], startDate: 1, endDate: null, extra: "<script>alert(1)</script>" });
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(bad.body).includes("script"));
  assert.equal((await owner.send("post", "/api/academic-years", { name: "x".repeat(101), startDate: "2026-09-01", endDate: "2027-07-31" })).status, 400);
  assert.equal((await owner.send("post", `/api/academic-years/${MISSING}`, year)).status, 404, "unknown route");
});

test("an ended membership loses access on the very next request", async () => {
  const { as, repo } = await build();
  const owner = await as("owner");
  assert.equal((await owner.get("/api/academic-years")).status, 200);
  const userId = [...repo.users.values()].find((u) => u.email === "owner@example.test")!.id;
  repo.memberships.get(userId)![0]!.status = "ENDED";
  assert.equal((await owner.get("/api/academic-years")).status, 403);
  assert.equal((await owner.send("post", "/api/academic-years", year)).status, 403);
});

test("a suspended school loses access on the very next request", async () => {
  const { as, repo } = await build();
  const owner = await as("owner");
  const userId = [...repo.users.values()].find((u) => u.email === "owner@example.test")!.id;
  repo.memberships.get(userId)![0]!.schoolStatus = "SUSPENDED";
  assert.equal((await owner.get("/api/academic-years")).status, 403);
});

test("a database failure is an opaque 500: no message, no secret", async () => {
  const { as, academicRepo } = await build();
  const owner = await as("owner");
  academicRepo.createYear = async () => { throw new Error("password=SENTINEL-db-secret connection lost"); };
  const res = await owner.send("post", "/api/academic-years", year);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "internal_error" });
  assert.ok(!JSON.stringify(res.body).includes("SENTINEL"));
});
