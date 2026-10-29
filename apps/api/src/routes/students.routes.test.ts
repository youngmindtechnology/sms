import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { createAuthService } from "../auth/authService.js";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { RateLimiter } from "../http/rateLimiter.js";
import { createEnrollmentService } from "../students/enrollmentService.js";
import { createGuardianService } from "../students/guardianService.js";
import { createStudentService } from "../students/studentService.js";
import { MemoryRepository } from "../testing/memoryRepository.js";
import { MemoryStudentRepository } from "../testing/memoryStudentRepository.js";

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
  const studentRepo = new MemoryStudentRepository();
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

  const year = studentRepo.seedYear(SCHOOL_A, { name: "2026/2027", status: "ACTIVE", startDate: "2026-09-01", endDate: "2027-07-31" });
  const basic1 = studentRepo.seedClass(SCHOOL_A, "Basic 1");
  const basic2 = studentRepo.seedClass(SCHOOL_A, "Basic 2");
  const foreignYear = studentRepo.seedYear(SCHOOL_C, { name: "2026/2027", status: "ACTIVE", startDate: "2026-09-01", endDate: "2027-07-31" });
  const foreignClass = studentRepo.seedClass(SCHOOL_C, "Basic 1");

  const auth = createAuthService(repo, config);
  const app = createApp({
    config, auth,
    students: {
      students: createStudentService(studentRepo, () => NOW),
      guardians: createGuardianService(studentRepo),
      enrollments: createEnrollmentService(studentRepo, () => NOW),
    },
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
  return { app, repo, studentRepo, as, year, basic1, basic2, foreignYear, foreignClass };
}

type Person = Awaited<ReturnType<Awaited<ReturnType<typeof build>>["as"]>>;
const register = (owner: Person, extra: object = {}) =>
  owner.send("post", "/api/students", { firstName: "Ama", lastName: "Mensah", admissionNumber: "2026/0001", ...extra });

test("every students, guardians and enrollments route needs a signed-in session (401)", async () => {
  const { app } = await build();
  const routes = [
    ["get", "/api/students"], ["post", "/api/students"], ["get", `/api/students/${MISSING}`], ["patch", `/api/students/${MISSING}`], ["post", `/api/students/${MISSING}/status`],
    ["post", `/api/students/${MISSING}/guardians`], ["patch", `/api/students/${MISSING}/guardians/${MISSING}`], ["delete", `/api/students/${MISSING}/guardians/${MISSING}`],
    ["get", `/api/students/${MISSING}/enrollments`], ["post", `/api/students/${MISSING}/enrollments`], ["post", `/api/students/${MISSING}/enrollments/transfer`],
    ["get", "/api/guardians?search=ab"], ["get", `/api/guardians/${MISSING}`], ["patch", `/api/guardians/${MISSING}`], ["get", `/api/enrollments/roster?classId=${MISSING}&academicYearId=${MISSING}`],
  ] as const;
  for (const [method, path] of routes) assert.equal((await request(app)[method](path).set("Origin", ORIGIN)).status, 401, `${method} ${path}`);
});

test("owner: registers, lists, searches, views, edits and changes the status of a student", async () => {
  const { as } = await build();
  const owner = await as("owner");
  const created = await register(owner, { middleName: "Serwaa", dateOfBirth: "2018-05-04" });
  assert.equal(created.status, 201);
  assert.equal(created.headers["cache-control"], "no-store");
  assert.equal(created.body.admissionNumber, "2026/0001");
  const list = await owner.get("/api/students?search=mensah&pageSize=5");
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.items[0].current, null);
  assert.ok(!("dateOfBirth" in list.body.items[0]), "the list is minimal");
  const profile = await owner.get(`/api/students/${created.body.id}`);
  assert.equal(profile.body.student.dateOfBirth, "2018-05-04");
  assert.deepEqual(profile.body.guardians, []);
  assert.equal((await owner.send("patch", `/api/students/${created.body.id}`, { lastName: "Owusu" })).body.lastName, "Owusu");
  const status = await owner.send("post", `/api/students/${created.body.id}/status`, { status: "WITHDRAWN" });
  assert.equal(status.status, 200);
  assert.equal(status.body.student.status, "WITHDRAWN");
});

test("validation: bad bodies are 400 with field messages; duplicates and bad transitions are 409; nothing is echoed back", async () => {
  const { as, studentRepo } = await build();
  const owner = await as("owner");
  const bad = await owner.send("post", "/api/students", { firstName: "", lastName: "M" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "validation_error");
  assert.ok(bad.body.fields.firstName);
  assert.equal((await owner.send("post", "/api/students", { firstName: "A", lastName: "M", dateOfBirth: "2018-02-30" })).body.fields.dateOfBirth.length > 0, true);
  const shape = await owner.send("post", "/api/students", { firstName: ["a"], lastName: 1, extra: "<script>alert(1)</script>" });
  assert.equal(shape.status, 400);
  assert.ok(!JSON.stringify(shape.body).includes("script"));
  const first = await register(owner);
  const dup = await register(owner, { firstName: "Other", admissionNumber: "2026/0001" });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, "duplicate_admission_number");
  assert.equal((await owner.send("post", `/api/students/${first.body.id}/status`, { status: "ACTIVE" })).status, 409);
  assert.equal((await owner.send("post", `/api/students/${first.body.id}/status`, { status: "EXPELLED" })).status, 400);
  assert.equal((await owner.send("patch", "/api/students/not-a-uuid", { firstName: "x" })).status, 400);
  assert.equal(studentRepo.students.length, 1);
});

test("list: invalid paging, status and unknown query parameters are 400", async () => {
  const { as } = await build();
  const owner = await as("owner");
  for (const query of ["page=0", "page=abc", "pageSize=101", "pageSize=0", "status=GONE", `classId=nope`, "unknown=1", "page=-1"]) {
    assert.equal((await owner.get(`/api/students?${query}`)).status, 400, query);
  }
  assert.equal((await owner.get("/api/students?page=1&pageSize=100&status=ACTIVE")).status, 200);
});

test("permissions: owner, headteacher and administrator write; teacher and bursar can read but never write", async () => {
  const { as, studentRepo, year, basic1 } = await build();
  for (const [who, adm] of [["head", "H-1"], ["admin", "A-1"]] as const) {
    assert.equal((await register(await as(who), { admissionNumber: adm })).status, 201, who);
  }
  const owner = await as("owner");
  const s = (await register(owner)).body;
  const g = (await owner.send("post", `/api/students/${s.id}/guardians`, { guardian: { fullName: "Abena Mensah", phone: "0241234567" }, relationship: "MOTHER" })).body;
  await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id });
  const before = JSON.stringify([studentRepo.students, studentRepo.guardians, studentRepo.links, studentRepo.enrollments]);

  for (const who of ["teacher", "bursar"] as const) {
    const person = await as(who);
    assert.equal((await person.get("/api/students")).status, 200, `${who} can list`);
    assert.equal((await person.get(`/api/students/${s.id}`)).status, 200, `${who} can view a profile`);
    assert.equal((await person.get(`/api/students/${s.id}/enrollments`)).status, 200);
    assert.equal((await person.get(`/api/guardians/${g.guardian.id}`)).status, 200);
    assert.equal((await person.get(`/api/enrollments/roster?classId=${basic1.id}&academicYearId=${year.id}`)).status, 200);
    const writes: Array<["post" | "patch" | "delete", string, object?]> = [
      ["post", "/api/students", { firstName: "X", lastName: "Y" }],
      ["patch", `/api/students/${s.id}`, { firstName: "Hacked" }],
      ["post", `/api/students/${s.id}/status`, { status: "WITHDRAWN" }],
      ["post", `/api/students/${s.id}/guardians`, { guardianId: g.guardian.id, relationship: "OTHER" }],
      ["patch", `/api/students/${s.id}/guardians/${g.guardian.id}`, { relationship: "FATHER" }],
      ["delete", `/api/students/${s.id}/guardians/${g.guardian.id}`],
      ["patch", `/api/guardians/${g.guardian.id}`, { fullName: "Hacked" }],
      ["post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id }],
      ["post", `/api/students/${s.id}/enrollments/transfer`, { classId: basic1.id }],
    ];
    for (const [method, path, body] of writes) {
      const denied = await person.send(method, path, body);
      assert.equal(denied.status, 403, `${who} ${method} ${path}`);
      assert.equal(denied.body.error, "insufficient_permission");
    }
    assert.equal((await person.get("/api/guardians?search=abena")).status, 403, `${who} can't search guardians (that is for linking)`);
  }
  assert.equal(JSON.stringify([studentRepo.students, studentRepo.guardians, studentRepo.links, studentRepo.enrollments]), before, "nothing changed");
});

test("guardians over HTTP: create + link, share with a sibling, primary switching, edit, duplicate refusal, unlink", async () => {
  const { as, studentRepo } = await build();
  const owner = await as("owner");
  const ama = (await register(owner)).body;
  const kofi = (await register(owner, { firstName: "Kofi", admissionNumber: "2026/0002" })).body;

  const made = await owner.send("post", `/api/students/${ama.id}/guardians`, { guardian: { fullName: "Abena Mensah", phone: "024 123 4567", email: "ABENA@example.com" }, relationship: "MOTHER" });
  assert.equal(made.status, 201);
  assert.equal(made.body.guardian.phone, "+233241234567");
  assert.equal(made.body.link.isPrimaryContact, true);
  const gid = made.body.guardian.id as string;

  const shared = await owner.send("post", `/api/students/${kofi.id}/guardians`, { guardianId: gid, relationship: "MOTHER" });
  assert.equal(shared.status, 201);
  assert.equal(shared.body.guardian.id, gid);
  assert.equal(studentRepo.guardians.length, 1, "one guardian record for two children");
  assert.equal((await owner.send("post", `/api/students/${kofi.id}/guardians`, { guardianId: gid, relationship: "FATHER" })).status, 409);
  assert.equal((await owner.send("post", `/api/students/${ama.id}/guardians`, { guardian: { fullName: "X", phone: "123" }, relationship: "MOTHER" })).status, 400);
  assert.equal((await owner.send("post", `/api/students/${ama.id}/guardians`, { guardian: { fullName: "X", phone: "0201112222" }, relationship: "AUNTIE" })).status, 400);

  const father = await owner.send("post", `/api/students/${ama.id}/guardians`, { guardian: { fullName: "Kwame Mensah", phone: "0201112222" }, relationship: "FATHER", isPrimaryContact: true });
  assert.equal(father.body.link.isPrimaryContact, true);
  const profile = await owner.get(`/api/students/${ama.id}`);
  assert.deepEqual(profile.body.guardians.filter((x: { isPrimaryContact: boolean }) => x.isPrimaryContact).map((x: { fullName: string }) => x.fullName), ["Kwame Mensah"]);

  assert.equal((await owner.send("patch", `/api/students/${ama.id}/guardians/${gid}`, { isPrimaryContact: true })).body.isPrimaryContact, true);
  assert.equal((await owner.send("patch", `/api/guardians/${gid}`, { email: "new@example.com" })).body.email, "new@example.com");
  assert.equal((await owner.get(`/api/guardians/${gid}`)).body.students.length, 2);
  assert.equal((await owner.get("/api/guardians?search=0241234567")).body.guardians.length, 1, "a local-format phone finds the +233 record");
  assert.equal((await owner.get("/api/guardians?search=a")).status, 400);

  const removed = await owner.send("delete", `/api/students/${ama.id}/guardians/${gid}`);
  assert.equal(removed.status, 200);
  assert.equal(studentRepo.guardians.length, 2, "guardian records kept");
  assert.equal(studentRepo.links.filter((l) => l.guardianId === gid).length, 1, "the sibling's link remains");
  assert.equal((await owner.send("delete", `/api/students/${ama.id}/guardians/${gid}`)).status, 404, "already removed");
});

test("enrollments over HTTP: enroll, refuse a double enrollment, change class keeping history, roster, withdraw", async () => {
  const { as, studentRepo, year, basic1, basic2 } = await build();
  const owner = await as("owner");
  const s = (await register(owner)).body;

  const enrolled = await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" });
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.body.className, "Basic 1");
  assert.equal((await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic2.id, academicYearId: year.id })).status, 409);
  assert.equal((await owner.get(`/api/students?classId=${basic1.id}`)).body.items[0].current.className, "Basic 1");

  const moved = await owner.send("post", `/api/students/${s.id}/enrollments/transfer`, { classId: basic2.id, effectiveDate: "2026-10-15" });
  assert.equal(moved.status, 201);
  assert.equal(moved.body.ended.status, "CLASS_CHANGED");
  assert.equal(moved.body.ended.endDate, "2026-10-14");
  assert.equal(moved.body.created.className, "Basic 2");
  const history = await owner.get(`/api/students/${s.id}/enrollments`);
  assert.deepEqual(history.body.enrollments.map((e: { className: string; status: string }) => [e.className, e.status]), [["Basic 2", "ENROLLED"], ["Basic 1", "CLASS_CHANGED"]]);
  assert.equal(studentRepo.enrollments.length, 2, "history kept");

  const roster = await owner.get(`/api/enrollments/roster?classId=${basic2.id}&academicYearId=${year.id}`);
  assert.equal(roster.body.entries.length, 1);
  assert.equal(roster.body.class.name, "Basic 2");
  assert.equal((await owner.get(`/api/enrollments/roster?classId=${basic1.id}&academicYearId=${year.id}`)).body.entries.length, 0);
  assert.equal((await owner.get(`/api/enrollments/roster?classId=${basic1.id}&academicYearId=${year.id}&includeEnded=true`)).body.entries.length, 1);
  assert.equal((await owner.get(`/api/enrollments/roster?classId=${basic1.id}`)).status, 400);

  const out = await owner.send("post", `/api/students/${s.id}/status`, { status: "WITHDRAWN", effectiveDate: "2026-10-20" });
  assert.equal(out.body.closedEnrollmentIds.length, 1);
  assert.equal(studentRepo.enrollments.length, 2, "nothing deleted");
  assert.equal((await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id })).status, 409, "withdrawn students can't be enrolled");
});

test("reactivated student over HTTP: reactivating enrolls nobody; enrolling again is 201 with a new id and the old row stays WITHDRAWN", async () => {
  const { as, studentRepo, year, basic1, basic2 } = await build();
  const owner = await as("owner");
  const s = (await register(owner)).body;
  const first = await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" });
  assert.equal(first.status, 201);
  await owner.send("post", `/api/students/${s.id}/status`, { status: "WITHDRAWN", effectiveDate: "2026-10-20" });
  const oldRow = JSON.stringify(studentRepo.enrollments.find((e) => e.id === first.body.id));

  const back = await owner.send("post", `/api/students/${s.id}/status`, { status: "ACTIVE" });
  assert.equal(back.status, 200);
  assert.equal(studentRepo.enrollments.length, 1, "no enrollment is created by reactivating");

  const again = await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.id, first.body.id);
  assert.equal(JSON.stringify(studentRepo.enrollments.find((e) => e.id === first.body.id)), oldRow);

  const history = await owner.get(`/api/students/${s.id}/enrollments`);
  assert.deepEqual(history.body.enrollments.map((e: { status: string }) => e.status), ["ENROLLED", "WITHDRAWN"]);
  assert.equal((await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic2.id, academicYearId: year.id })).status, 409, "a current enrollment still blocks a second one");
});

test("enrollment rules over HTTP: inactive class and closed year are 409, foreign ids are 400, unknown student is 404", async () => {
  const { as, studentRepo, year, basic1, foreignClass, foreignYear } = await build();
  const owner = await as("owner");
  const s = (await register(owner)).body;
  const retired = studentRepo.seedClass(SCHOOL_A, "Old", false);
  assert.equal((await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: retired.id, academicYearId: year.id })).body.error, "class_inactive");
  const closed = studentRepo.seedYear(SCHOOL_A, { name: "2025/2026", status: "CLOSED", startDate: "2025-09-01", endDate: "2026-07-31" });
  assert.equal((await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: closed.id, startDate: "2026-01-01" })).body.error, "year_closed");
  assert.equal((await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: foreignClass.id, academicYearId: year.id })).status, 400);
  assert.equal((await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: foreignYear.id })).status, 400);
  assert.equal((await owner.send("post", `/api/students/${MISSING}/enrollments`, { classId: basic1.id, academicYearId: year.id })).status, 404);
  assert.equal(studentRepo.enrollments.length, 0);
});

test("tenant isolation: another school's owner gets 404 for every record, identical to a made-up id, and changes nothing", async () => {
  const { as, studentRepo, year, basic1, foreignClass, foreignYear } = await build();
  const owner = await as("owner");
  const s = (await register(owner)).body;
  const g = (await owner.send("post", `/api/students/${s.id}/guardians`, { guardian: { fullName: "Abena Mensah", phone: "0241234567" }, relationship: "MOTHER" })).body.guardian;
  await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id });
  const before = JSON.stringify([studentRepo.students, studentRepo.guardians, studentRepo.links, studentRepo.enrollments]);

  const outsider = await as("outsider");
  assert.deepEqual((await outsider.get("/api/students")).body.items, []);
  assert.equal((await outsider.get(`/api/students?classId=${basic1.id}`)).body.total, 0);
  const probes: Array<["get" | "post" | "patch" | "delete", (id: string) => string, object?]> = [
    ["get", (id) => `/api/students/${id}`],
    ["patch", (id) => `/api/students/${id}`, { firstName: "Hacked" }],
    ["post", (id) => `/api/students/${id}/status`, { status: "WITHDRAWN" }],
    ["post", (id) => `/api/students/${id}/guardians`, { guardian: { fullName: "X", phone: "0201112222" }, relationship: "OTHER" }],
    ["patch", (id) => `/api/students/${id}/guardians/${g.id}`, { relationship: "FATHER" }],
    ["delete", (id) => `/api/students/${id}/guardians/${g.id}`],
    ["get", (id) => `/api/students/${id}/enrollments`],
    ["post", (id) => `/api/students/${id}/enrollments`, { classId: foreignClass.id, academicYearId: foreignYear.id }],
    ["post", (id) => `/api/students/${id}/enrollments/transfer`, { classId: foreignClass.id }],
  ];
  for (const [method, path, body] of probes) {
    const real = await (method === "get" ? outsider.get(path(s.id)) : outsider.send(method, path(s.id), body));
    const fake = await (method === "get" ? outsider.get(path(MISSING)) : outsider.send(method, path(MISSING), body));
    assert.equal(real.status, 404, `${method} ${path(s.id)}`);
    assert.deepEqual(real.body, fake.body, "the same answer as a record that does not exist");
    assert.deepEqual(real.body, { error: "not_found" });
  }
  for (const [method, path, body] of [["get", `/api/guardians/${g.id}`], ["patch", `/api/guardians/${g.id}`, { fullName: "Hacked" }]] as const) {
    const res = await (method === "get" ? outsider.get(path) : outsider.send(method, path, body));
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "not_found" });
  }
  assert.deepEqual((await outsider.get("/api/guardians?search=abena")).body.guardians, []);
  assert.equal((await outsider.get(`/api/enrollments/roster?classId=${basic1.id}&academicYearId=${year.id}`)).status, 404);
  // Using another school's class or year ids from the outsider's own student: indistinguishable from made-up ids.
  const mine = (await outsider.send("post", "/api/students", { firstName: "Out", lastName: "Sider" })).body;
  const viaForeign = await outsider.send("post", `/api/students/${mine.id}/enrollments`, { classId: basic1.id, academicYearId: foreignYear.id });
  const viaMissing = await outsider.send("post", `/api/students/${mine.id}/enrollments`, { classId: MISSING, academicYearId: foreignYear.id });
  assert.deepEqual(viaForeign.body, viaMissing.body);
  assert.equal(JSON.stringify([studentRepo.students.filter((x) => x.schoolId === SCHOOL_A), studentRepo.guardians, studentRepo.links, studentRepo.enrollments]), before, "school A's data is unchanged");
});

test("a school id from the client is never used", async () => {
  const { as, studentRepo } = await build();
  const outsider = await as("outsider");
  assert.equal((await outsider.send("post", "/api/students", { firstName: "X", lastName: "Y", schoolId: SCHOOL_A })).status, 400, "unknown body field refused");
  assert.equal((await outsider.send("post", "/api/students", { firstName: "X", lastName: "Y", school_id: SCHOOL_A })).status, 400);
  assert.equal(studentRepo.students.length, 0);
  assert.equal((await outsider.send("post", `/api/students?schoolId=${SCHOOL_A}`, { firstName: "X", lastName: "Y" })).status, 201);
  assert.equal(studentRepo.students[0]!.schoolId, SCHOOL_C, "saved in the session's school, not the query's");
  assert.equal((await outsider.get(`/api/students?schoolId=${SCHOOL_A}`)).status, 400, "unknown query parameter refused");
  const owner = await as("owner");
  assert.equal((await owner.get("/api/students")).body.total, 0, "school A sees none of school C's students");
});

test("state-changing calls need the trusted Origin and the CSRF token", async () => {
  const { app, as, studentRepo } = await build();
  const owner = await as("owner");
  const attempt = (headers: Record<string, string>) => request(app).post("/api/students").set("Cookie", owner.cookie).set(headers).send({ firstName: "X", lastName: "Y" });
  assert.equal((await attempt({ "X-CSRF-Token": owner.csrf })).status, 403);
  assert.equal((await attempt({ Origin: ORIGIN })).status, 403);
  assert.equal((await attempt({ Origin: "http://evil.test", "X-CSRF-Token": owner.csrf })).status, 403);
  assert.equal(studentRepo.students.length, 0);
});

test("an ended membership or a suspended school loses access on the very next request", async () => {
  const { as, repo } = await build();
  const owner = await as("owner");
  assert.equal((await owner.get("/api/students")).status, 200);
  const userId = [...repo.users.values()].find((u) => u.email === "owner@example.test")!.id;
  repo.memberships.get(userId)![0]!.status = "ENDED";
  assert.equal((await owner.get("/api/students")).status, 403);
  assert.equal((await register(owner)).status, 403);
  repo.memberships.get(userId)![0]!.status = "ACTIVE";
  assert.equal((await owner.get("/api/students")).status, 200);
  repo.memberships.get(userId)![0]!.schoolStatus = "SUSPENDED";
  assert.equal((await owner.get("/api/students")).status, 403);
});

test("there is no way to delete a student, a guardian or an enrollment", async () => {
  const { as, studentRepo, year, basic1 } = await build();
  const owner = await as("owner");
  const s = (await register(owner)).body;
  const g = (await owner.send("post", `/api/students/${s.id}/guardians`, { guardian: { fullName: "Abena", phone: "0241234567" }, relationship: "MOTHER" })).body.guardian;
  const e = (await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id })).body;
  for (const path of [`/api/students/${s.id}`, "/api/students", `/api/guardians/${g.id}`, `/api/students/${s.id}/enrollments`, `/api/students/${s.id}/enrollments/${e.id}`]) {
    const res = await owner.send("delete", path);
    assert.ok([404, 405].includes(res.status), `DELETE ${path} -> ${res.status}`);
  }
  assert.equal(studentRepo.students.length, 1);
  assert.equal(studentRepo.guardians.length, 1);
  assert.equal(studentRepo.enrollments.length, 1);
});

test("audit hygiene: after a full flow no audit event holds a name, phone, e-mail, date of birth or admission number", async () => {
  const { as, studentRepo, year, basic1, basic2 } = await build();
  const owner = await as("owner");
  const s = (await register(owner, { middleName: "Serwaa", dateOfBirth: "2018-05-04" })).body;
  const g = (await owner.send("post", `/api/students/${s.id}/guardians`, { guardian: { fullName: "Abena Mensah", phone: "0241234567", email: "abena@example.com" }, relationship: "MOTHER" })).body.guardian;
  await owner.send("patch", `/api/guardians/${g.id}`, { phone: "0207654321" });
  await owner.send("patch", `/api/students/${s.id}`, { firstName: "Adwoa" });
  await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" });
  await owner.send("post", `/api/students/${s.id}/enrollments/transfer`, { classId: basic2.id, effectiveDate: "2026-10-15" });
  await owner.send("post", `/api/students/${s.id}/status`, { status: "WITHDRAWN" });
  await owner.send("delete", `/api/students/${s.id}/guardians/${g.id}`);
  const text = JSON.stringify(studentRepo.audit);
  for (const secret of ["Ama", "Mensah", "Serwaa", "Adwoa", "Abena", "2018-05-04", "0241234567", "233241234567", "207654321", "abena@example.com", "2026/0001", "Basic 1", "Basic 2"]) {
    assert.ok(!text.includes(secret), `audit leaked ${secret}`);
  }
  const actions = studentRepo.audit.map((e) => e.action);
  for (const wanted of ["student.created", "guardian.created", "student.guardian_linked", "guardian.updated", "student.updated", "enrollment.created", "enrollment.class_changed", "student.status_changed", "enrollment.ended", "student.guardian_unlinked"]) {
    assert.ok(actions.includes(wanted), `missing audit action ${wanted}`);
  }
  assert.ok(studentRepo.audit.every((e) => e.schoolId === SCHOOL_A && e.actorUserId));
});

test("a database failure is an opaque 500: no message, no secret", async () => {
  const { as, studentRepo } = await build();
  const owner = await as("owner");
  studentRepo.createStudent = async () => { throw new Error("password=SENTINEL-db-secret connection lost"); };
  const res = await register(owner);
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "internal_error" });
  assert.ok(!JSON.stringify(res.body).includes("SENTINEL"));
});

test("a failed class change over HTTP leaves the original enrollment untouched", async () => {
  const { as, studentRepo, year, basic1, basic2 } = await build();
  const owner = await as("owner");
  const s = (await register(owner)).body;
  await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" });
  const before = JSON.stringify(studentRepo.enrollments);
  studentRepo.failNextTransfer = true;
  const res = await owner.send("post", `/api/students/${s.id}/enrollments/transfer`, { classId: basic2.id, effectiveDate: "2026-10-15" });
  assert.equal(res.status, 500);
  assert.equal(JSON.stringify(studentRepo.enrollments), before);
});

const DOB = "2018-05-04";
const SECRETS = /2018-05-04|\+233241234567|0241234567|abena@example\.com/;

test("privacy over HTTP: owner, headteacher and administrator see the date of birth and guardian contact details", async () => {
  const { as, basic1, year } = await build();
  const owner = await as("owner");
  const s = (await register(owner, { middleName: "Serwaa", dateOfBirth: DOB })).body;
  await owner.send("post", `/api/students/${s.id}/guardians`, { guardian: { fullName: "Abena Mensah", phone: "0241234567", email: "Abena@example.com" }, relationship: "MOTHER" });
  await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id });

  for (const who of ["owner", "head", "admin"] as const) {
    const person = await as(who);
    const profile = await person.get(`/api/students/${s.id}`);
    assert.equal(profile.status, 200, who);
    assert.equal(profile.body.student.dateOfBirth, DOB, `${who}: date of birth`);
    assert.equal(profile.body.guardians[0].phone, "+233241234567", `${who}: guardian phone in the profile`);
    assert.equal(profile.body.guardians[0].email, "abena@example.com", `${who}: guardian email in the profile`);
    const detail = await person.get(`/api/guardians/${profile.body.guardians[0].id}`);
    assert.equal(detail.body.guardian.phone, "+233241234567", `${who}: guardian detail phone`);
    assert.equal(detail.body.guardian.email, "abena@example.com", `${who}: guardian detail email`);
    const found = await person.get("/api/guardians?search=abena");
    assert.equal(found.body.guardians[0].phone, "+233241234567", `${who}: guardian search phone`);
  }
});

test("privacy over HTTP: teacher and bursar get null for the date of birth and no guardian phone or e-mail anywhere, but everything else", async () => {
  const { as, basic1, year } = await build();
  const owner = await as("owner");
  const s = (await register(owner, { middleName: "Serwaa", dateOfBirth: DOB, admittedOn: "2026-09-01" })).body;
  const g = (await owner.send("post", `/api/students/${s.id}/guardians`, { guardian: { fullName: "Abena Mensah", phone: "0241234567", email: "Abena@example.com" }, relationship: "MOTHER" })).body.guardian;
  await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id });

  for (const who of ["teacher", "bursar"] as const) {
    const person = await as(who);

    const profile = await person.get(`/api/students/${s.id}`);
    assert.equal(profile.status, 200, who);
    assert.equal(profile.body.student.dateOfBirth, null, `${who}: date of birth is hidden`);
    assert.deepEqual(
      { id: profile.body.student.id, admissionNumber: profile.body.student.admissionNumber, firstName: profile.body.student.firstName, middleName: profile.body.student.middleName, lastName: profile.body.student.lastName, admittedOn: profile.body.student.admittedOn, status: profile.body.student.status },
      { id: s.id, admissionNumber: "2026/0001", firstName: "Ama", middleName: "Serwaa", lastName: "Mensah", admittedOn: "2026-09-01", status: "ACTIVE" },
      `${who}: the other student fields are still there`,
    );
    // Nested guardian object inside the profile.
    assert.equal(profile.body.guardians.length, 1);
    assert.equal(profile.body.guardians[0].phone, null, `${who}: nested guardian phone`);
    assert.equal(profile.body.guardians[0].email, null, `${who}: nested guardian email`);
    assert.equal(profile.body.guardians[0].fullName, "Abena Mensah");
    assert.equal(profile.body.guardians[0].relationship, "MOTHER");
    assert.equal(profile.body.guardians[0].isPrimaryContact, true);
    assert.equal(profile.body.enrollments[0].className, "Basic 1", "enrollments are unchanged");
    assert.equal(profile.body.current.className, "Basic 1");

    // Guardian detail.
    const detail = await person.get(`/api/guardians/${g.id}`);
    assert.equal(detail.status, 200, who);
    assert.equal(detail.body.guardian.phone, null);
    assert.equal(detail.body.guardian.email, null);
    assert.equal(detail.body.guardian.fullName, "Abena Mensah");
    assert.equal(detail.body.students[0].id, s.id, "linked students are still listed");
    assert.equal(detail.body.students[0].relationship, "MOTHER");

    // Every other read response must not contain any of the secret values at all.
    for (const path of ["/api/students", `/api/students/${s.id}/enrollments`, `/api/enrollments/roster?classId=${basic1.id}&academicYearId=${year.id}`]) {
      const res = await person.get(path);
      assert.equal(res.status, 200, `${who} ${path}`);
      assert.doesNotMatch(JSON.stringify(res.body), SECRETS, `${who} ${path}`);
    }
    assert.doesNotMatch(JSON.stringify([profile.body, detail.body]), SECRETS, `${who}: no secret value anywhere in the JSON`);
    assert.equal((await person.get("/api/students")).body.items[0].firstName, "Ama", "the list still works");

    // Guardian search is a write-role feature and stays refused, with no data in the refusal.
    const search = await person.get("/api/guardians?search=abena");
    assert.equal(search.status, 403);
    assert.doesNotMatch(JSON.stringify(search.body), SECRETS);
  }
});

test("privacy over HTTP: hiding is done for the response only; the stored values are unchanged, and a query string cannot ask for them", async () => {
  const { as, studentRepo } = await build();
  const owner = await as("owner");
  const s = (await register(owner, { dateOfBirth: DOB })).body;
  const teacher = await as("teacher");
  // Nothing the client sends can switch the filter off: the flag comes from the verified session only.
  assert.equal((await teacher.get(`/api/students/${s.id}?sensitive=true`)).status, 200, "the profile route ignores query strings");
  assert.equal((await teacher.get(`/api/students/${s.id}`)).body.student.dateOfBirth, null);
  assert.equal(studentRepo.students[0]!.dateOfBirth, DOB, "the stored date of birth is untouched");
});

test("transfer race over HTTP: a stale class change is a clean 409 and changes nothing", async () => {
  const { as, studentRepo, year, basic1, basic2 } = await build();
  const owner = await as("owner");
  const s = (await register(owner)).body;
  const basic3 = studentRepo.seedClass(SCHOOL_A, "Basic 3");
  await owner.send("post", `/api/students/${s.id}/enrollments`, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" });
  let snapshot = "";
  studentRepo.beforeTransfer = () => {
    const open = studentRepo.enrollments.find((e) => e.status === "ENROLLED")!;
    open.status = "CLASS_CHANGED";
    open.endDate = "2026-10-09";
    studentRepo.enrollments.push({ id: "e0000000-0000-4000-8000-0000000000c2", schoolId: SCHOOL_A, studentId: s.id, classId: basic2.id, academicYearId: year.id, status: "ENROLLED", startDate: "2026-10-10", endDate: "2027-07-31" });
    snapshot = JSON.stringify(studentRepo.enrollments);
  };
  const res = await owner.send("post", `/api/students/${s.id}/enrollments/transfer`, { classId: basic3.id, effectiveDate: "2026-10-15" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "already_enrolled");
  assert.ok(res.body.fields.effectiveDate);
  assert.equal(JSON.stringify(studentRepo.enrollments), snapshot);
});
