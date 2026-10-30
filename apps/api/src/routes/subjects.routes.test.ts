import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { createAuthService } from "../auth/authService.js";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { RateLimiter } from "../http/rateLimiter.js";
import { MemoryRepository } from "../testing/memoryRepository.js";
import { MemorySubjectRepository } from "../testing/memorySubjectRepository.js";
import { createSubjectService } from "../subjects/subjectService.js";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";
const SCHOOL_A = "10000000-0000-4000-8000-0000000000a1";
const SCHOOL_C = "10000000-0000-4000-8000-0000000000c1";
const MISSING = "40000000-0000-4000-8000-0000000000ff";
const NOW = new Date("2026-10-27T10:00:00.000Z");
const config = loadConfig({ DATABASE_URL: "postgresql://app:SENTINEL-db-secret@localhost:5432/ymt_dev", FRONTEND_ORIGIN: ORIGIN });

type Role = "OWNER" | "HEADTEACHER" | "ADMINISTRATOR" | "TEACHER" | "BURSAR";

async function build() {
  const repo = new MemoryRepository();
  const subjectRepo = new MemorySubjectRepository(repo, () => NOW);
  const { hash, algorithm } = await hashPassword(PASSWORD, { algorithm: "scrypt", fast: true });
  const emails: Record<string, string> = {};
  const memberships: Record<string, string> = {};
  const add = (key: string, schoolId: string, schoolName: string, roles: Role[]) => {
    const email = `${key}@example.test`;
    const user = repo.addUser({ email, fullName: key, status: "ACTIVE" }, { passwordHash: hash, algorithm });
    repo.addMembership(user.id, { schoolId, schoolName, schoolStatus: "ACTIVE", status: "ACTIVE", roles });
    emails[key] = email;
    memberships[key] = repo.memberships.get(user.id)![0]!.membershipId;
  };
  add("owner", SCHOOL_A, "Alpha", ["OWNER"]);
  add("head", SCHOOL_A, "Alpha", ["HEADTEACHER"]);
  add("admin", SCHOOL_A, "Alpha", ["ADMINISTRATOR"]);
  add("teacher", SCHOOL_A, "Alpha", ["TEACHER"]);
  add("teacher2", SCHOOL_A, "Alpha", ["TEACHER"]);
  add("bursar", SCHOOL_A, "Alpha", ["BURSAR"]);
  add("outsider", SCHOOL_C, "Charlie", ["OWNER"]);
  add("outsiderTeacher", SCHOOL_C, "Charlie", ["TEACHER"]);

  const year = subjectRepo.seedYear(SCHOOL_A, "2026/2027", "ACTIVE");
  const closedYear = subjectRepo.seedYear(SCHOOL_A, "2025/2026", "CLOSED");
  const p4 = subjectRepo.seedClass(SCHOOL_A, "Primary 4");
  const foreignClass = subjectRepo.seedClass(SCHOOL_C, "Primary 4");
  const foreignYear = subjectRepo.seedYear(SCHOOL_C, "2026/2027", "ACTIVE");

  const auth = createAuthService(repo, config);
  const app = createApp({
    config, auth, subjects: createSubjectService(subjectRepo, () => NOW),
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
  return { app, repo, subjectRepo, as, memberships, year, closedYear, p4, foreignClass, foreignYear };
}

const createSubject = (who: Awaited<ReturnType<Awaited<ReturnType<typeof build>>["as"]>>, classId: string, name = "Mathematics", code?: string) =>
  who.send("post", "/api/subjects", { classId, name, ...(code ? { code } : {}) });

test("every subjects and teaching-assignment route needs a signed-in session (401)", async () => {
  const { app, p4 } = await build();
  const routes = [
    ["get", `/api/subjects?classId=${p4.id}`], ["post", "/api/subjects"], ["patch", `/api/subjects/${MISSING}`],
    ["get", `/api/subjects/${MISSING}/assignments`], ["post", `/api/subjects/${MISSING}/assignments`],
    ["get", "/api/teaching-assignments/eligible-teachers"], ["post", `/api/teaching-assignments/${MISSING}/replace`], ["post", `/api/teaching-assignments/${MISSING}/end`],
  ] as const;
  for (const [method, path] of routes) assert.equal((await request(app)[method](path).set("Origin", ORIGIN)).status, 401, `${method} ${path}`);
});

test("owner: creates, lists with teachers, edits, deactivates and reactivates a subject", async () => {
  const { as, p4, year, memberships } = await build();
  const owner = await as("owner");
  const empty = await owner.get(`/api/subjects?classId=${p4.id}&academicYearId=${year.id}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers["cache-control"], "no-store");
  assert.deepEqual(empty.body.subjects, []);
  assert.equal(empty.body.class.name, "Primary 4");

  const created = await createSubject(owner, p4.id, "  Mathematics ", "math");
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "Mathematics");
  assert.equal(created.body.code, "MATH");
  const id = created.body.id as string;

  assert.equal((await owner.send("post", `/api/subjects/${id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher })).status, 201);
  const listed = await owner.get(`/api/subjects?classId=${p4.id}&academicYearId=${year.id}`);
  assert.equal(listed.body.subjects[0].teachers[0].teacherName, "teacher");

  const patched = await owner.send("patch", `/api/subjects/${id}`, { name: "Maths", code: null });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.code, null);
  assert.equal((await owner.send("patch", `/api/subjects/${id}`, { isActive: false })).body.isActive, false);
  assert.equal((await owner.send("patch", `/api/subjects/${id}`, { isActive: true })).body.isActive, true);
});

test("validation: bad bodies are 400 with field messages; duplicates, inactive classes and closed years are 409", async () => {
  const { as, p4, closedYear, subjectRepo, memberships } = await build();
  const owner = await as("owner");
  const blank = await owner.send("post", "/api/subjects", { classId: p4.id, name: "  " });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error, "validation_error");
  assert.ok(blank.body.fields.name);
  assert.equal((await createSubject(owner, p4.id, "Maths")).status, 201);
  const dup = await createSubject(owner, p4.id, "MATHS");
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "duplicate_name");
  const retired = subjectRepo.seedClass(SCHOOL_A, "Retired", false);
  assert.equal((await createSubject(owner, retired.id)).status, 409);
  const subject = (await owner.get(`/api/subjects?classId=${p4.id}`)).body.subjects[0];
  const closed = await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: closedYear.id, teacherMembershipId: memberships.teacher });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, "year_closed");
});

test("assignments over HTTP: assign, refuse a duplicate, several teachers, replace keeping history, end", async () => {
  const { as, p4, year, memberships, subjectRepo } = await build();
  const owner = await as("owner");
  const subject = (await createSubject(owner, p4.id)).body;
  const base = `/api/subjects/${subject.id}/assignments`;

  const first = await owner.send("post", base, { academicYearId: year.id, teacherMembershipId: memberships.teacher });
  assert.equal(first.status, 201);
  assert.equal(first.body.status, "ACTIVE");
  assert.equal((await owner.send("post", base, { academicYearId: year.id, teacherMembershipId: memberships.teacher })).status, 409);
  assert.equal((await owner.send("post", base, { academicYearId: year.id, teacherMembershipId: memberships.teacher2 })).status, 201, "several teachers are allowed");

  const replaced = await owner.send("post", `/api/teaching-assignments/${first.body.id}/replace`, { teacherMembershipId: memberships.admin });
  assert.equal(replaced.status, 409, "an administrator is not a teacher");

  const ended = await owner.send("post", `/api/teaching-assignments/${first.body.id}/end`);
  assert.equal(ended.status, 200);
  assert.equal(ended.body.status, "ENDED");
  assert.equal((await owner.send("post", `/api/teaching-assignments/${first.body.id}/end`)).status, 409);
  const all = await owner.get(`${base}?includeEnded=true`);
  assert.equal(all.body.assignments.length, 2, "history kept");
  assert.equal((await owner.get(base)).body.assignments.length, 1);
  assert.equal(subjectRepo.assignments.length, 2);
});

test("replace over HTTP: 201 with the ended and the new record; the old one stays as history", async () => {
  const { as, p4, year, memberships, subjectRepo } = await build();
  const owner = await as("owner");
  const subject = (await createSubject(owner, p4.id)).body;
  const first = await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher });
  const replaced = await owner.send("post", `/api/teaching-assignments/${first.body.id}/replace`, { teacherMembershipId: memberships.teacher2 });
  assert.equal(replaced.status, 201);
  assert.equal(replaced.body.ended.status, "ENDED");
  assert.equal(replaced.body.created.status, "ACTIVE");
  assert.equal(replaced.body.created.teacherName, "teacher2");
  assert.equal(subjectRepo.assignments.length, 2);
});

test("a failed replacement over HTTP leaves the original assignment untouched", async () => {
  const { as, p4, year, memberships, subjectRepo } = await build();
  const owner = await as("owner");
  const subject = (await createSubject(owner, p4.id)).body;
  const first = await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher });
  const before = JSON.stringify(subjectRepo.assignments);
  subjectRepo.failNextReplace = true;
  const res = await owner.send("post", `/api/teaching-assignments/${first.body.id}/replace`, { teacherMembershipId: memberships.teacher2 });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "internal_error" });
  assert.equal(JSON.stringify(subjectRepo.assignments), before);
});

test("eligible teachers: only active teachers of this school, as membership id and name; nothing else", async () => {
  const { as, memberships } = await build();
  const owner = await as("owner");
  const res = await owner.get("/api/teaching-assignments/eligible-teachers");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.teachers.map((t: { fullName: string }) => t.fullName), ["teacher", "teacher2"]);
  assert.deepEqual(Object.keys(res.body.teachers[0]).sort(), ["fullName", "membershipId"]);
  assert.equal(res.body.teachers[0].membershipId, memberships.teacher);
  assert.ok(!JSON.stringify(res.body).includes("@example.test"));
});

test("permissions: owner, headteacher and administrator manage and assign; teacher reads only; bursar is refused everything", async () => {
  const { as, p4, year, memberships } = await build();
  const owner = await as("owner");
  const subject = (await createSubject(owner, p4.id, "Seed Subject")).body;
  const assignment = (await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher })).body;

  for (const key of ["head", "admin"]) {
    const who = await as(key);
    assert.equal((await who.get(`/api/subjects?classId=${p4.id}`)).status, 200, `${key} reads`);
    assert.equal((await createSubject(who, p4.id, `By ${key}`)).status, 201, `${key} creates`);
    assert.equal((await who.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher2 })).status, 201, `${key} assigns`);
    assert.equal((await who.get("/api/teaching-assignments/eligible-teachers")).status, 200);
    const created = (await who.get(`/api/subjects/${subject.id}/assignments`)).body.assignments.find((a: { teacherName: string }) => a.teacherName === "teacher2");
    assert.equal((await who.send("post", `/api/teaching-assignments/${created.id}/end`)).status, 200, `${key} ends`);
  }

  const teacher = await as("teacher");
  assert.equal((await teacher.get(`/api/subjects?classId=${p4.id}&academicYearId=${year.id}`)).status, 200, "teacher can view");
  assert.equal((await teacher.get(`/api/subjects/${subject.id}/assignments`)).status, 200);
  const before = JSON.stringify(await owner.get(`/api/subjects?classId=${p4.id}&academicYearId=${year.id}`).then((r) => r.body));
  for (const [method, path, body] of [
    ["post", "/api/subjects", { classId: p4.id, name: "Nope" }],
    ["patch", `/api/subjects/${subject.id}`, { name: "Nope" }],
    ["post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher2 }],
    ["post", `/api/teaching-assignments/${assignment.id}/replace`, { teacherMembershipId: memberships.teacher2 }],
    ["post", `/api/teaching-assignments/${assignment.id}/end`, {}],
  ] as const) {
    assert.equal((await teacher.send(method, path, body)).status, 403, `teacher ${method} ${path}`);
  }
  assert.equal((await teacher.get("/api/teaching-assignments/eligible-teachers")).status, 403, "teachers cannot list candidates");
  assert.equal(JSON.stringify(await owner.get(`/api/subjects?classId=${p4.id}&academicYearId=${year.id}`).then((r) => r.body)), before, "nothing changed");

  const bursar = await as("bursar");
  assert.equal((await bursar.get(`/api/subjects?classId=${p4.id}`)).status, 403);
  assert.equal((await bursar.get(`/api/subjects/${subject.id}/assignments`)).status, 403);
  assert.equal((await createSubject(bursar, p4.id, "Nope")).status, 403);
  assert.equal((await bursar.send("post", `/api/teaching-assignments/${assignment.id}/end`)).status, 403);
});

test("tenant isolation: another school's owner gets 404 for every record, identical to a made-up id, and changes nothing", async () => {
  const { as, p4, year, memberships, subjectRepo, foreignYear } = await build();
  const owner = await as("owner");
  const subject = (await createSubject(owner, p4.id)).body;
  const assignment = (await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher })).body;
  const outsider = await as("outsider");
  const before = JSON.stringify([subjectRepo.subjects, subjectRepo.assignments]);

  const real = [
    await outsider.get(`/api/subjects?classId=${p4.id}`),
    await outsider.send("patch", `/api/subjects/${subject.id}`, { name: "Hacked" }),
    await outsider.get(`/api/subjects/${subject.id}/assignments`),
    await outsider.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: foreignYear.id, teacherMembershipId: memberships.outsiderTeacher }),
    await outsider.send("post", `/api/teaching-assignments/${assignment.id}/replace`, { teacherMembershipId: memberships.outsiderTeacher }),
    await outsider.send("post", `/api/teaching-assignments/${assignment.id}/end`),
  ];
  const fake = [
    await outsider.get(`/api/subjects?classId=${MISSING}`),
    await outsider.send("patch", `/api/subjects/${MISSING}`, { name: "Hacked" }),
    await outsider.get(`/api/subjects/${MISSING}/assignments`),
    await outsider.send("post", `/api/subjects/${MISSING}/assignments`, { academicYearId: foreignYear.id, teacherMembershipId: memberships.outsiderTeacher }),
    await outsider.send("post", `/api/teaching-assignments/${MISSING}/replace`, { teacherMembershipId: memberships.outsiderTeacher }),
    await outsider.send("post", `/api/teaching-assignments/${MISSING}/end`),
  ];
  real.forEach((r, i) => { assert.equal(r.status, 404, `real ${i}`); assert.deepEqual(r.body, fake[i]!.body, `same body ${i}`); });
  assert.equal(JSON.stringify([subjectRepo.subjects, subjectRepo.assignments]), before, "nothing changed");

  // A class or teacher from the other school used in a body is rejected, not accepted.
  assert.equal((await createSubject(outsider, p4.id)).status, 400);
  assert.equal((await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.outsiderTeacher })).status, 400);
  assert.equal((await outsider.get("/api/teaching-assignments/eligible-teachers")).body.teachers.length, 1);
});

test("a school id from the client is never used: unknown body and query fields are refused", async () => {
  const { as, p4, year, memberships, foreignClass } = await build();
  const owner = await as("owner");
  const smuggled = await owner.send("post", "/api/subjects", { classId: p4.id, name: "X", schoolId: SCHOOL_C });
  assert.equal(smuggled.status, 400);
  assert.equal((await owner.send("post", "/api/subjects", { classId: foreignClass.id, name: "X", school_id: SCHOOL_C })).status, 400);
  const subject = (await createSubject(owner, p4.id)).body;
  assert.equal((await owner.send("patch", `/api/subjects/${subject.id}`, { classId: foreignClass.id })).status, 400, "a subject cannot be moved to another class");
  assert.equal((await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher, schoolId: SCHOOL_C })).status, 400);
  assert.equal((await owner.get(`/api/subjects?classId=${p4.id}&schoolId=${SCHOOL_C}`)).status, 400);
});

test("state-changing calls need the trusted Origin and the CSRF token", async () => {
  const { app, as, p4, subjectRepo } = await build();
  const owner = await as("owner");
  const attempt = (headers: Record<string, string>) => request(app).post("/api/subjects").set("Cookie", owner.cookie).set(headers).send({ classId: p4.id, name: "X" });
  assert.equal((await attempt({ "X-CSRF-Token": owner.csrf })).status, 403);
  assert.equal((await attempt({ Origin: ORIGIN })).status, 403);
  assert.equal((await attempt({ Origin: "http://evil.test", "X-CSRF-Token": owner.csrf })).status, 403);
  assert.equal(subjectRepo.subjects.length, 0);
});

test("malformed ids, queries and bodies are 400 and are not echoed back", async () => {
  const { as, p4 } = await build();
  const owner = await as("owner");
  assert.equal((await owner.get("/api/subjects")).status, 400, "classId is required");
  assert.equal((await owner.get("/api/subjects?classId=not-a-uuid")).status, 400);
  assert.equal((await owner.get(`/api/subjects?classId=${p4.id}&academicYearId=nope`)).status, 400);
  assert.equal((await owner.send("patch", "/api/subjects/not-a-uuid", { name: "x" })).status, 400);
  assert.equal((await owner.get("/api/subjects/not-a-uuid/assignments")).status, 400);
  assert.equal((await owner.get(`/api/subjects/${MISSING}/assignments?includeEnded=maybe`)).status, 400);
  assert.equal((await owner.send("post", "/api/teaching-assignments/not-a-uuid/end")).status, 400);
  assert.equal((await owner.send("post", `/api/teaching-assignments/${MISSING}/end`, { extra: 1 })).status, 400);
  const bad = await owner.send("post", "/api/subjects", { classId: [1], name: { a: 1 }, extra: "<script>alert(1)</script>" });
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(bad.body).includes("script"));
  assert.equal((await owner.send("post", `/api/subjects/${MISSING}/assignments`, {})).status, 400);
});

test("there is no way to delete a subject or an assignment over HTTP", async () => {
  const { as, p4, year, memberships, subjectRepo } = await build();
  const owner = await as("owner");
  const subject = (await createSubject(owner, p4.id)).body;
  const assignment = (await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher })).body;
  for (const path of [`/api/subjects/${subject.id}`, `/api/subjects/${subject.id}/assignments/${assignment.id}`, `/api/teaching-assignments/${assignment.id}`, "/api/subjects"]) {
    assert.equal((await owner.send("delete", path)).status, 404, path);
  }
  assert.equal(subjectRepo.subjects.length, 1);
  assert.equal(subjectRepo.assignments.length, 1);
});

test("audit hygiene: after a full flow no audit event holds a name, e-mail, password, hash or token", async () => {
  const { as, p4, year, memberships, subjectRepo } = await build();
  const owner = await as("owner");
  const subject = (await createSubject(owner, p4.id, "Mathematics", "MATH")).body;
  const first = (await owner.send("post", `/api/subjects/${subject.id}/assignments`, { academicYearId: year.id, teacherMembershipId: memberships.teacher })).body;
  const second = (await owner.send("post", `/api/teaching-assignments/${first.id}/replace`, { teacherMembershipId: memberships.teacher2 })).body.created;
  await owner.send("post", `/api/teaching-assignments/${second.id}/end`);
  await owner.send("patch", `/api/subjects/${subject.id}`, { name: "Maths", isActive: false });
  const text = JSON.stringify(subjectRepo.audit);
  for (const secret of ["@example.test", "teacher2", "Mathematics", "Maths", "MATH", "password", "hash", "token", "csrf"]) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(subjectRepo.audit.map((e) => e.action), [
    "subject.created", "teaching_assignment.created", "teaching_assignment.replaced", "teaching_assignment.ended", "subject.updated",
  ]);
  assert.ok(subjectRepo.audit.every((e) => e.schoolId === SCHOOL_A));
});

test("an ended membership or a suspended school loses access on the very next request", async () => {
  const { as, repo, p4 } = await build();
  const owner = await as("owner");
  assert.equal((await owner.get(`/api/subjects?classId=${p4.id}`)).status, 200);
  const userId = [...repo.users.values()].find((u) => u.email === "owner@example.test")!.id;
  repo.memberships.get(userId)![0]!.status = "ENDED";
  assert.equal((await owner.get(`/api/subjects?classId=${p4.id}`)).status, 403);
  assert.equal((await createSubject(owner, p4.id)).status, 403);
  repo.memberships.get(userId)![0]!.status = "ACTIVE";
  repo.memberships.get(userId)![0]!.schoolStatus = "SUSPENDED";
  assert.equal((await owner.get(`/api/subjects?classId=${p4.id}`)).status, 403);
});

test("a database failure is an opaque 500: no message, no secret", async () => {
  const { as, subjectRepo, p4 } = await build();
  const owner = await as("owner");
  subjectRepo.createSubject = async () => { throw new Error("password=SENTINEL-db-secret connection lost"); };
  const res = await createSubject(owner, p4.id);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "internal_error" });
  assert.ok(!JSON.stringify(res.body).includes("SENTINEL"));
});
