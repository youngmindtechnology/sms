import assert from "node:assert/strict";
import { test } from "node:test";
import { A, B, MISSING, ama, errorOf, fieldsOf, setup, unwrap } from "./testKit.js";
import { RepositoryConflict } from "../academic/ports.js";

async function ready() {
  const kit = setup();
  const school = kit.seedSchool();
  const student = unwrap(await kit.students.register(A, ama));
  return { ...kit, ...school, student };
}

test("enroll: a valid enrollment runs from today to the end of the academic year", async () => {
  const { enrollments, student, year, basic1, repo } = await ready();
  const e = unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  assert.equal(e.status, "ENROLLED");
  assert.equal(e.className, "Basic 1");
  assert.equal(e.academicYearName, "2026/2027");
  assert.equal(e.startDate, "2026-10-27");
  assert.equal(e.endDate, "2027-07-31");
  assert.equal(repo.enrollments[0]!.schoolId, A.schoolId);
  assert.deepEqual(repo.audit.at(-1)!.metadata, { studentId: student.id, classId: basic1.id, academicYearId: year.id });
  assert.equal(repo.audit.at(-1)!.action, "enrollment.created");
});

test("enroll: before the year starts the default start is the first day of the year; an explicit date must be inside the year", async () => {
  const { enrollments, students, seedSchool } = setup(new Date("2026-08-01T00:00:00Z"));
  const { year, basic1 } = seedSchool();
  const s = unwrap(await students.register(A, ama));
  assert.equal(unwrap(await enrollments.enroll(A, s.id, { classId: basic1.id, academicYearId: year.id })).startDate, "2026-09-01");
  const t = unwrap(await students.register(A, { firstName: "Kofi", lastName: "B" }));
  for (const startDate of ["2026-08-31", "2027-08-01"]) {
    assert.ok(fieldsOf(await enrollments.enroll(A, t.id, { classId: basic1.id, academicYearId: year.id, startDate })).startDate, startDate);
  }
  assert.equal(unwrap(await enrollments.enroll(A, t.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-15" })).startDate, "2026-09-15");
});

test("enroll: missing or malformed ids and dates are rejected", async () => {
  const { enrollments, student, year, basic1, repo } = await ready();
  for (const [input, field] of [
    [{ academicYearId: year.id }, "classId"], [{ classId: basic1.id }, "academicYearId"], [{ classId: 5, academicYearId: year.id }, "classId"],
    [{ classId: MISSING, academicYearId: year.id }, "classId"], [{ classId: basic1.id, academicYearId: MISSING }, "academicYearId"],
    [{ classId: basic1.id, academicYearId: year.id, startDate: "soon" }, "startDate"], [{ classId: basic1.id, academicYearId: year.id, startDate: "2026-02-30" }, "startDate"],
  ] as const) {
    const r = await enrollments.enroll(A, student.id, input);
    assert.equal(errorOf(r), "validation_error", JSON.stringify(input));
    assert.ok(fieldsOf(r)[field], field);
  }
  assert.equal(repo.enrollments.length, 0);
});

test("enroll: an inactive class is refused; a closed academic year is refused; planned and active years are fine", async () => {
  const { enrollments, student, year, repo } = await ready();
  const retired = repo.seedClass(A.schoolId, "Old class", false);
  assert.equal(errorOf(await enrollments.enroll(A, student.id, { classId: retired.id, academicYearId: year.id })), "class_inactive");
  const closed = repo.seedYear(A.schoolId, { name: "2025/2026", status: "CLOSED", startDate: "2025-09-01", endDate: "2026-07-31" });
  const open = repo.seedClass(A.schoolId, "Basic 3");
  assert.equal(errorOf(await enrollments.enroll(A, student.id, { classId: open.id, academicYearId: closed.id, startDate: "2026-01-10" })), "year_closed");
  const planned = repo.seedYear(A.schoolId, { name: "2027/2028", status: "PLANNED", startDate: "2027-09-01", endDate: "2028-07-31" });
  unwrap(await enrollments.enroll(A, student.id, { classId: open.id, academicYearId: planned.id }));
  assert.equal(repo.enrollments.length, 1);
});

test("enroll: only ACTIVE students; withdrawn, transferred and graduated students are refused", async () => {
  const { enrollments, students, student, year, basic1 } = await ready();
  for (const status of ["WITHDRAWN", "TRANSFERRED_OUT", "GRADUATED"]) {
    unwrap(await students.changeStatus(A, student.id, { status }));
    assert.equal(errorOf(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id })), "student_not_active", status);
    unwrap(await students.changeStatus(A, student.id, { status: "ACTIVE" }));
  }
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
});

test("enroll: a student can't be enrolled twice for the same period, in the same class or another", async () => {
  const { enrollments, student, year, basic1, basic2, repo } = await ready();
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  assert.equal(errorOf(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id })), "already_enrolled");
  assert.equal(errorOf(await enrollments.enroll(A, student.id, { classId: basic2.id, academicYearId: year.id })), "already_enrolled");
  assert.equal(repo.enrollments.length, 1);
});

test("enroll: the database overlap refusal (a race between two requests) is a clean already_enrolled, not a 500", async () => {
  const { enrollments, student, year, basic1, repo } = await ready();
  const original = repo.listEnrollments.bind(repo);
  repo.listEnrollments = async () => []; // the service's pre-check sees nothing, as if the other request had not landed yet
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  assert.equal(errorOf(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id })), "already_enrolled");
  repo.listEnrollments = original;
  assert.equal(repo.enrollments.length, 1);
});

test("history: a past year's enrollment does not block the next year, and the profile lists both newest first", async () => {
  const { enrollments, students, student, year, basic1, basic2, repo } = await ready();
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  const next = repo.seedYear(A.schoolId, { name: "2027/2028", status: "PLANNED", startDate: "2027-09-01", endDate: "2028-07-31" });
  const e2 = unwrap(await enrollments.enroll(A, student.id, { classId: basic2.id, academicYearId: next.id }));
  assert.equal(e2.startDate, "2027-09-01");
  const profile = unwrap(await students.profile(A, student.id));
  assert.deepEqual(profile.enrollments.map((e) => e.academicYearName), ["2027/2028", "2026/2027"]);
  assert.equal(profile.current?.academicYearName, "2027/2028", "the newest open enrollment is current");
});

test("transfer: the old enrollment ends the day before as CLASS_CHANGED and a new one starts - nothing is overwritten", async () => {
  const { enrollments, student, year, basic1, basic2, repo } = await ready();
  const first = unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));
  const r = unwrap(await enrollments.transfer(A, student.id, { classId: basic2.id, effectiveDate: "2026-10-15" }));
  assert.equal(r.ended.id, first.id, "the same row is ended, not replaced");
  assert.equal(r.ended.status, "CLASS_CHANGED");
  assert.equal(r.ended.endDate, "2026-10-14");
  assert.equal(r.ended.className, "Basic 1");
  assert.equal(r.created.status, "ENROLLED");
  assert.equal(r.created.className, "Basic 2");
  assert.equal(r.created.startDate, "2026-10-15");
  assert.equal(r.created.endDate, "2027-07-31");
  assert.equal(repo.enrollments.length, 2, "both rows exist");
  const event = repo.audit.at(-1)!;
  assert.equal(event.action, "enrollment.class_changed");
  assert.deepEqual(event.metadata, { studentId: student.id, fromClassId: basic1.id, toClassId: basic2.id, academicYearId: year.id, fromEnrollmentId: first.id });
});

test("transfer: the effective date defaults to today and can be repeated (Basic 1 -> 2 -> 1) with every step kept", async () => {
  const { enrollments, student, year, basic1, basic2, repo } = await ready();
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));
  unwrap(await enrollments.transfer(A, student.id, { classId: basic2.id, effectiveDate: "2026-09-20" }));
  const back = unwrap(await enrollments.transfer(A, student.id, { classId: basic1.id }));
  assert.equal(back.created.startDate, "2026-10-27");
  assert.deepEqual(repo.enrollments.map((e) => e.status).sort(), ["CLASS_CHANGED", "CLASS_CHANGED", "ENROLLED"]);
});

test("transfer: refused when there is no current enrollment, the class is inactive or the same, or the date is wrong", async () => {
  const { enrollments, student, year, basic1, basic2, repo } = await ready();
  assert.equal(errorOf(await enrollments.transfer(A, student.id, { classId: basic2.id })), "no_current_enrollment");
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));
  const retired = repo.seedClass(A.schoolId, "Old", false);
  assert.equal(errorOf(await enrollments.transfer(A, student.id, { classId: retired.id })), "class_inactive");
  assert.ok(fieldsOf(await enrollments.transfer(A, student.id, { classId: basic1.id })).classId, "same class");
  assert.ok(fieldsOf(await enrollments.transfer(A, student.id, { classId: basic2.id, effectiveDate: "2026-09-01" })).effectiveDate, "must be after the enrollment began, so history exists");
  assert.ok(fieldsOf(await enrollments.transfer(A, student.id, { classId: basic2.id, effectiveDate: "2027-08-01" })).effectiveDate, "after the year ends");
  assert.ok(fieldsOf(await enrollments.transfer(A, student.id, { classId: basic2.id, effectiveDate: "garbage" })).effectiveDate);
  assert.equal(errorOf(await enrollments.transfer(A, student.id, { classId: MISSING })), "validation_error");
  assert.equal(repo.enrollments.length, 1);
  assert.equal(repo.enrollments[0]!.status, "ENROLLED");
});

test("transfer: not allowed once the academic year is closed, or for a student who has left", async () => {
  const { enrollments, students, student, year, basic1, basic2, repo } = await ready();
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));
  repo.years[0]!.status = "CLOSED";
  assert.equal(errorOf(await enrollments.transfer(A, student.id, { classId: basic2.id })), "year_closed");
  repo.years[0]!.status = "ACTIVE";
  unwrap(await students.changeStatus(A, student.id, { status: "WITHDRAWN" }));
  assert.equal(errorOf(await enrollments.transfer(A, student.id, { classId: basic2.id })), "student_not_active");
});

test("transfer is all or nothing: a failure part-way leaves the original enrollment exactly as it was", async () => {
  const { enrollments, student, year, basic1, basic2, repo } = await ready();
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));
  const before = JSON.stringify(repo.enrollments);
  const auditBefore = repo.audit.length;
  repo.failNextTransfer = true;
  await assert.rejects(enrollments.transfer(A, student.id, { classId: basic2.id, effectiveDate: "2026-10-15" }), /simulated/);
  assert.equal(JSON.stringify(repo.enrollments), before);
  assert.equal(repo.audit.length, auditBefore);
});

test("roster: ordered by name, current students only by default, ended ones with includeEnded", async () => {
  const { enrollments, students, student, year, basic1, basic2 } = await ready();
  const kofi = unwrap(await students.register(A, { firstName: "Kofi", lastName: "Addo" }));
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));
  unwrap(await enrollments.enroll(A, kofi.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));
  assert.deepEqual(unwrap(await enrollments.roster(A, basic1.id, year.id, false)).entries.map((e) => e.student.lastName), ["Addo", "Mensah"]);
  unwrap(await enrollments.transfer(A, student.id, { classId: basic2.id, effectiveDate: "2026-10-15" }));
  assert.deepEqual(unwrap(await enrollments.roster(A, basic1.id, year.id, false)).entries.map((e) => e.student.lastName), ["Addo"]);
  const all = unwrap(await enrollments.roster(A, basic1.id, year.id, true)).entries;
  assert.deepEqual(all.map((e) => [e.student.lastName, e.status]), [["Addo", "ENROLLED"], ["Mensah", "CLASS_CHANGED"]]);
  assert.deepEqual(unwrap(await enrollments.roster(A, basic2.id, year.id, false)).entries.map((e) => e.student.lastName), ["Mensah"]);
  const entry = unwrap(await enrollments.roster(A, basic2.id, year.id, false)).entries[0]!;
  assert.ok(!("dateOfBirth" in entry.student), "rosters carry minimal student fields");
});

test("tenant isolation: another school's student, class, year and roster look exactly like missing ones", async () => {
  const { enrollments, students, student, year, basic1, repo } = await ready();
  const other = setupOther();
  function setupOther() { return { year: repo.seedYear(B.schoolId, { name: "2026/2027", status: "ACTIVE", startDate: "2026-09-01", endDate: "2027-07-31" }), cls: repo.seedClass(B.schoolId, "Basic 1") }; }
  const outsider = unwrap(await students.register(B, { firstName: "Out", lastName: "Sider" }));
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  const snapshot = JSON.stringify(repo.enrollments);

  // B tries to use A's student, class and year.
  assert.equal(errorOf(await enrollments.enroll(B, student.id, { classId: other.cls.id, academicYearId: other.year.id })), "not_found");
  assert.equal(errorOf(await enrollments.list(B, student.id)), "not_found");
  assert.equal(errorOf(await enrollments.transfer(B, student.id, { classId: other.cls.id })), "not_found");
  const viaForeignClass = await enrollments.enroll(B, outsider.id, { classId: basic1.id, academicYearId: other.year.id });
  const viaMissingClass = await enrollments.enroll(B, outsider.id, { classId: MISSING, academicYearId: other.year.id });
  assert.deepEqual(viaForeignClass, viaMissingClass, "a foreign class is indistinguishable from a missing one");
  assert.equal(errorOf(await enrollments.enroll(B, outsider.id, { classId: other.cls.id, academicYearId: year.id })), "validation_error", "foreign year");
  assert.equal(errorOf(await enrollments.roster(B, basic1.id, year.id, true)), "not_found");
  assert.equal(errorOf(await enrollments.roster(A, other.cls.id, other.year.id, true)), "not_found");
  assert.equal(JSON.stringify(repo.enrollments), snapshot, "nothing changed");
});

test("list: unknown student is not_found; the enrollment audit carries ids only", async () => {
  const { enrollments, student, year, basic1, repo } = await ready();
  assert.equal(errorOf(await enrollments.list(A, MISSING)), "not_found");
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  const text = JSON.stringify(repo.audit);
  for (const secret of ["Ama", "Mensah", "2026/0001", "Basic 1"]) assert.ok(!text.includes(secret), `audit leaked ${secret}`);
});

test("transfer race: if another request already ended the enrollment, nothing changes and no extra enrollment is created", async () => {
  const { enrollments, student, year, basic1, basic2, repo } = await ready();
  const basic3 = repo.seedClass(A.schoolId, "Basic 3");
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));

  // Another request wins the race between our read and our write: it moves the student to Basic 2.
  let afterCompetitor = "";
  repo.beforeTransfer = () => {
    const open = repo.enrollments.find((e) => e.status === "ENROLLED")!;
    open.status = "CLASS_CHANGED";
    open.endDate = "2026-10-09";
    repo.enrollments.push({ id: "e0000000-0000-4000-8000-0000000000c2", schoolId: A.schoolId, studentId: student.id, classId: basic2.id, academicYearId: year.id, status: "ENROLLED", startDate: "2026-10-10", endDate: "2027-07-31" });
    afterCompetitor = JSON.stringify(repo.enrollments);
  };
  const auditBefore = repo.audit.length;
  const result = await enrollments.transfer(A, student.id, { classId: basic3.id, effectiveDate: "2026-10-15" });

  assert.equal(errorOf(result), "already_enrolled");
  assert.ok(fieldsOf(result).effectiveDate, "a clear message for the user");
  assert.equal(JSON.stringify(repo.enrollments), afterCompetitor, "the competitor's result is exactly as it was: nothing overwritten, nothing added");
  assert.equal(repo.enrollments.length, 2);
  assert.equal(repo.audit.length, auditBefore, "no audit event for a change that did not happen");
});

test("transfer race at the repository: an enrollment that is no longer ENROLLED cannot be ended again; a wrong student or school finds nothing", async () => {
  const { enrollments, student, year, basic1, basic2, repo, students } = await ready();
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-09-01" }));
  const moved = unwrap(await enrollments.transfer(A, student.id, { classId: basic2.id, effectiveDate: "2026-10-15" }));
  const before = JSON.stringify(repo.enrollments);
  const next = { studentId: student.id, classId: basic1.id, academicYearId: year.id, startDate: "2026-11-01", endDate: "2027-07-31" };

  // moved.ended is the already-ended row: ending it again must be refused.
  await assert.rejects(repo.transferEnrollment(A.schoolId, moved.ended.id, "2026-10-31", next), RepositoryConflict);
  assert.equal(JSON.stringify(repo.enrollments), before);

  // The student does not match the enrollment, or the school does not: indistinguishable from missing.
  const other = unwrap(await students.register(A, { firstName: "Kofi", lastName: "Addo", admissionNumber: "2026/0009" }));
  assert.equal(await repo.transferEnrollment(A.schoolId, moved.created.id, "2026-10-31", { ...next, studentId: other.id }), null);
  assert.equal(await repo.transferEnrollment(B.schoolId, moved.created.id, "2026-10-31", next), null);
  assert.equal(JSON.stringify(repo.enrollments), before);
});

// ---- Reactivated students (withdraw -> ACTIVE -> enroll again) ---------------------------

async function withdrawnAndBack(effectiveDate: string) {
  const ctx = await ready();
  const first = unwrap(await ctx.enrollments.enroll(A, ctx.student.id, { classId: ctx.basic1.id, academicYearId: ctx.year.id, startDate: "2026-09-01" }));
  unwrap(await ctx.students.changeStatus(A, ctx.student.id, { status: "WITHDRAWN", effectiveDate }));
  const oldRow = JSON.stringify(ctx.repo.enrollments.find((e) => e.id === first.id));
  unwrap(await ctx.students.changeStatus(A, ctx.student.id, { status: "ACTIVE" }));
  return { ...ctx, first, oldRow };
}

test("reactivated: changing back to ACTIVE creates no enrollment by itself", async () => {
  const { repo, student } = await withdrawnAndBack("2026-10-20");
  assert.equal(repo.enrollments.length, 1);
  assert.equal(repo.enrollments.filter((e) => e.studentId === student.id && e.status === "ENROLLED").length, 0);
});

test("reactivated: enrolls again in the SAME class; the old row stays WITHDRAWN and unchanged; the new row is separate", async () => {
  const { enrollments, student, year, basic1, repo, first, oldRow } = await withdrawnAndBack("2026-10-20");
  const again = unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  assert.notEqual(again.id, first.id);
  assert.equal(again.status, "ENROLLED");
  assert.equal(again.className, "Basic 1");
  assert.equal(again.startDate, "2026-10-27");
  assert.equal(again.endDate, "2027-07-31");
  assert.equal(JSON.stringify(repo.enrollments.find((e) => e.id === first.id)), oldRow, "old row untouched");
  assert.equal(repo.enrollments.find((e) => e.id === first.id)!.status, "WITHDRAWN");
  assert.equal(repo.enrollments.length, 2);
  assert.equal(repo.audit.at(-1)!.action, "enrollment.created");
});

test("reactivated: the profile shows the new current class and keeps both records, newest first", async () => {
  const { enrollments, student, year, basic1, first } = await withdrawnAndBack("2026-10-20");
  const again = unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  const history = unwrap(await enrollments.list(A, student.id));
  assert.deepEqual(history.map((e) => [e.id, e.status]), [[again.id, "ENROLLED"], [first.id, "WITHDRAWN"]]);
});

test("reactivated: can enroll in a DIFFERENT class too", async () => {
  const { enrollments, student, year, basic2, repo } = await withdrawnAndBack("2026-10-20");
  const e = unwrap(await enrollments.enroll(A, student.id, { classId: basic2.id, academicYearId: year.id }));
  assert.equal(e.className, "Basic 2");
  assert.equal(repo.enrollments.length, 2);
});

test("reactivated on the same day as the withdrawal: starts the next day (no shared day), with a clear message for an earlier date", async () => {
  const { enrollments, student, year, basic1, repo, first, oldRow } = await withdrawnAndBack("2026-10-27");
  const early = await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-10-27" });
  assert.equal(errorOf(early), "validation_error");
  assert.match(fieldsOf(early).startDate!, /2026-10-27.*2026-10-28/);
  assert.equal(repo.enrollments.length, 1, "nothing created by the refused call");
  const e = unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  assert.equal(e.startDate, "2026-10-28");
  assert.equal(JSON.stringify(repo.enrollments.find((x) => x.id === first.id)), oldRow);
});

test("reactivated: a student who now has a current enrollment cannot be enrolled twice", async () => {
  const { enrollments, student, year, basic1, basic2, repo } = await withdrawnAndBack("2026-10-20");
  unwrap(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id }));
  const second = await enrollments.enroll(A, student.id, { classId: basic2.id, academicYearId: year.id });
  assert.equal(errorOf(second), "already_enrolled");
  assert.match(fieldsOf(second).startDate!, /Change class/);
  assert.equal(repo.enrollments.length, 2);
});

test("reactivated: inactive classes and closed years are still refused; other schools still look like missing records", async () => {
  const { enrollments, student, year, basic1, repo } = await withdrawnAndBack("2026-10-20");
  repo.classes.find((c) => c.id === basic1.id)!.isActive = false;
  assert.equal(errorOf(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id })), "class_inactive");
  repo.classes.find((c) => c.id === basic1.id)!.isActive = true;
  repo.years[0]!.status = "CLOSED";
  assert.equal(errorOf(await enrollments.enroll(A, student.id, { classId: basic1.id, academicYearId: year.id })), "year_closed");
  repo.years[0]!.status = "ACTIVE";
  assert.equal(errorOf(await enrollments.enroll(B, student.id, { classId: basic1.id, academicYearId: year.id })), "not_found");
  assert.equal(repo.enrollments.length, 1);
});
