import assert from "node:assert/strict";
import { test } from "node:test";
import { A, RESTRICTED, B, MISSING, ama, errorOf, fieldsOf, setup, unwrap } from "./testKit.js";

test("register: trims names, upper-cases and trims the admission number, stores nothing else", async () => {
  const { students, repo } = setup();
  const s = unwrap(await students.register(A, { admissionNumber: "  adm/2026-01 ", firstName: "  Ama  ", middleName: "  Serwaa ", lastName: " Mensah", dateOfBirth: "2018-05-04", admittedOn: "2026-09-01" }));
  assert.equal(s.admissionNumber, "ADM/2026-01");
  assert.equal(s.firstName, "Ama");
  assert.equal(s.middleName, "Serwaa");
  assert.equal(s.status, "ACTIVE");
  assert.equal(repo.students[0]!.schoolId, A.schoolId);
  assert.deepEqual(Object.keys(s).sort(), ["admissionNumber", "admittedOn", "dateOfBirth", "firstName", "id", "lastName", "middleName", "status"]);
});

test("register: with no admission number one is generated (year/0001, then 0002) and is unique", async () => {
  const { students } = setup();
  assert.equal(unwrap(await students.register(A, { firstName: "Ama", lastName: "Mensah" })).admissionNumber, "2026/0001");
  assert.equal(unwrap(await students.register(A, { firstName: "Kofi", lastName: "Boateng" })).admissionNumber, "2026/0002");
  // A manually typed number can sit in the way of the generator; it moves on to the next free one.
  unwrap(await students.register(A, { admissionNumber: "2026/0004", firstName: "Esi", lastName: "Owusu" }));
  assert.equal(unwrap(await students.register(A, { firstName: "Yaw", lastName: "Addo" })).admissionNumber, "2026/0005");
  // Another school starts from its own count.
  assert.equal(unwrap(await students.register(B, { firstName: "Ama", lastName: "Mensah" })).admissionNumber, "2026/0001");
});

test("register: missing and malformed fields are rejected with field messages", async () => {
  const { students, repo } = setup();
  for (const [input, field] of [
    [{ lastName: "Mensah" }, "firstName"], [{ firstName: "Ama" }, "lastName"], [{ firstName: "", lastName: "M" }, "firstName"], [{ firstName: "   ", lastName: "M" }, "firstName"],
    [{ firstName: "x".repeat(101), lastName: "M" }, "firstName"], [{ firstName: 5, lastName: "M" }, "firstName"], [{ firstName: "A\u0007", lastName: "M" }, "firstName"],
    [{ firstName: "A", lastName: "M", middleName: "y".repeat(101) }, "middleName"],
    [{ firstName: "A", lastName: "M", admissionNumber: "BAD NUMBER" }, "admissionNumber"], [{ firstName: "A", lastName: "M", admissionNumber: "x".repeat(41) }, "admissionNumber"],
    [{ firstName: "A", lastName: "M", admissionNumber: "<script>" }, "admissionNumber"], [{ firstName: "A", lastName: "M", admissionNumber: 12 }, "admissionNumber"],
    [{ firstName: "A", lastName: "M", dateOfBirth: "2018-02-30" }, "dateOfBirth"], [{ firstName: "A", lastName: "M", dateOfBirth: "04/05/2018" }, "dateOfBirth"],
    [{ firstName: "A", lastName: "M", dateOfBirth: "2027-01-01" }, "dateOfBirth"], [{ firstName: "A", lastName: "M", dateOfBirth: "1980-01-01" }, "dateOfBirth"],
    [{ firstName: "A", lastName: "M", admittedOn: "nonsense" }, "admittedOn"], [{ firstName: "A", lastName: "M", dateOfBirth: "2018-01-01", admittedOn: "2017-01-01" }, "admittedOn"],
  ] as const) {
    const r = await students.register(A, input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(errorOf(r), "validation_error");
    assert.ok(fieldsOf(r)[field], `expected a message for ${field} in ${JSON.stringify(input)}`);
  }
  assert.equal(repo.students.length, 0, "nothing saved");
  assert.equal(repo.audit.length, 0, "nothing audited");
});

test("register: a duplicate admission number in the same school is refused, in any letter case; another school may reuse it", async () => {
  const { students } = setup();
  unwrap(await students.register(A, ama));
  const dup = await students.register(A, { ...ama, firstName: "Other", admissionNumber: " 2026/0001 " });
  assert.equal(errorOf(dup), "duplicate_admission_number");
  assert.ok(fieldsOf(dup).admissionNumber);
  unwrap(await students.register(A, { firstName: "A", lastName: "B", admissionNumber: "abc" }));
  assert.equal(errorOf(await students.register(A, { firstName: "C", lastName: "D", admissionNumber: "ABC" })), "duplicate_admission_number");
  unwrap(await students.register(B, ama));
});

test("register: the audit event holds ids and flags only - no name, date of birth or admission number", async () => {
  const { students, repo } = setup();
  unwrap(await students.register(A, { ...ama, dateOfBirth: "2018-05-04" }));
  const text = JSON.stringify(repo.audit);
  for (const secret of ["Ama", "Mensah", "2018-05-04", "2026/0001"]) assert.ok(!text.includes(secret), `audit leaked ${secret}`);
  assert.equal(repo.audit[0]!.action, "student.created");
  assert.equal(repo.audit[0]!.schoolId, A.schoolId);
  assert.equal(repo.audit[0]!.actorUserId, A.userId);
});

test("list: only this school's students, ordered by name, with page and total", async () => {
  const { students } = setup();
  for (const [first, last] of [["Kofi", "Boateng"], ["Ama", "Mensah"], ["Esi", "Addo"]]) unwrap(await students.register(A, { firstName: first, lastName: last }));
  unwrap(await students.register(B, { firstName: "Other", lastName: "School" }));
  const page = unwrap(await students.list(A, {}));
  assert.deepEqual(page.items.map((s) => s.lastName), ["Addo", "Boateng", "Mensah"]);
  assert.equal(page.total, 3);
  assert.equal(page.page, 1);
  assert.equal(page.pageSize, 20);
  assert.ok(page.items.every((s) => !("dateOfBirth" in s)), "list rows are minimal");
  const second = unwrap(await students.list(A, { page: 2, pageSize: 2 }));
  assert.deepEqual(second.items.map((s) => s.lastName), ["Mensah"]);
  assert.equal(second.total, 3);
});

test("list: search by name words (any order, any case), by part of the admission number, and by status", async () => {
  const { students } = setup();
  const ama1 = unwrap(await students.register(A, { admissionNumber: "2026/0001", firstName: "Ama", middleName: "Serwaa", lastName: "Mensah" }));
  unwrap(await students.register(A, { admissionNumber: "2026/0002", firstName: "Kofi", lastName: "Mensah" }));
  unwrap(await students.register(A, { admissionNumber: "2025/0107", firstName: "Esi", lastName: "Addo" }));
  const names = async (search: string) => unwrap(await students.list(A, { search })).items.map((s) => s.firstName);
  assert.deepEqual(await names("mensah"), ["Ama", "Kofi"]);
  assert.deepEqual(await names("ama mensah"), ["Ama"]);
  assert.deepEqual(await names("MENSAH AMA"), ["Ama"]);
  assert.deepEqual(await names("serwaa"), ["Ama"]);
  assert.deepEqual(await names("0107"), ["Esi"]);
  assert.deepEqual(await names("2026/"), ["Ama", "Kofi"]);
  assert.deepEqual(await names("nobody"), []);
  assert.deepEqual(await names("%"), [], "wildcards are plain characters");
  unwrap(await students.changeStatus(A, ama1.id, { status: "WITHDRAWN" }));
  assert.deepEqual(unwrap(await students.list(A, { status: "WITHDRAWN" })).items.map((s) => s.firstName), ["Ama"]);
  assert.equal(unwrap(await students.list(A, { status: "ACTIVE" })).total, 2);
});

test("list: bad page, page size, status and search are rejected", async () => {
  const { students } = setup();
  for (const [input, field] of [
    [{ page: 0 }, "page"], [{ page: -1 }, "page"], [{ page: 1.5 }, "page"], [{ page: "2" }, "page"], [{ page: 10_001 }, "page"],
    [{ pageSize: 0 }, "pageSize"], [{ pageSize: 101 }, "pageSize"], [{ pageSize: "20" }, "pageSize"],
    [{ status: "GONE" }, "status"], [{ search: "x".repeat(101) }, "search"], [{ search: 5 }, "search"],
  ] as const) {
    const r = await students.list(A, input);
    assert.equal(errorOf(r), "validation_error", JSON.stringify(input));
    assert.ok(fieldsOf(r)[field], field);
  }
});

test("profile: an unknown id and another school's id are both not_found", async () => {
  const { students } = setup();
  const mine = unwrap(await students.register(A, ama));
  assert.equal(unwrap(await students.profile(A, mine.id)).student.id, mine.id);
  assert.equal(errorOf(await students.profile(B, mine.id)), "not_found");
  assert.equal(errorOf(await students.profile(A, MISSING)), "not_found");
});

test("update: changes only the fields sent, validates them, refuses duplicates and empty changes", async () => {
  const { students, repo } = setup();
  const s = unwrap(await students.register(A, { ...ama, middleName: "Serwaa" }));
  const other = unwrap(await students.register(A, { firstName: "Kofi", lastName: "Boateng", admissionNumber: "2026/0002" }));
  const updated = unwrap(await students.update(A, s.id, { lastName: " Mensah-Owusu ", middleName: null, dateOfBirth: "2018-05-04" }));
  assert.equal(updated.lastName, "Mensah-Owusu");
  assert.equal(updated.middleName, null);
  assert.equal(updated.firstName, "Ama", "untouched field kept");
  assert.equal(updated.dateOfBirth, "2018-05-04");
  assert.deepEqual(repo.audit.at(-1)!.metadata, { changed: ["lastName", "middleName", "dateOfBirth"] }, "audit names the fields, not the values");
  assert.equal(errorOf(await students.update(A, s.id, {})), "validation_error");
  assert.equal(errorOf(await students.update(A, s.id, { firstName: "" })), "validation_error");
  assert.equal(errorOf(await students.update(A, s.id, { admissionNumber: other.admissionNumber.toLowerCase() })), "duplicate_admission_number");
  assert.equal(errorOf(await students.update(A, s.id, { admittedOn: "2010-01-01", dateOfBirth: "2018-05-04" })), "validation_error");
  assert.equal(errorOf(await students.update(B, s.id, { firstName: "Hacked" })), "not_found");
  assert.equal(repo.students.find((x) => x.id === s.id)!.firstName, "Ama");
});

test("status: ACTIVE can end three ways; an ended student returns only through ACTIVE; same-status and unknown values are refused", async () => {
  const { students } = setup();
  const s = unwrap(await students.register(A, ama));
  assert.equal(errorOf(await students.changeStatus(A, s.id, { status: "ACTIVE" })), "invalid_status_change");
  assert.equal(errorOf(await students.changeStatus(A, s.id, { status: "EXPELLED" })), "validation_error");
  assert.equal(errorOf(await students.changeStatus(A, s.id, {})), "validation_error");
  assert.equal(errorOf(await students.changeStatus(A, s.id, { status: "WITHDRAWN", effectiveDate: "2099-01-01" })), "validation_error", "future dates refused");
  assert.equal(unwrap(await students.changeStatus(A, s.id, { status: "TRANSFERRED_OUT" })).student.status, "TRANSFERRED_OUT");
  assert.equal(errorOf(await students.changeStatus(A, s.id, { status: "GRADUATED" })), "invalid_status_change");
  assert.equal(unwrap(await students.changeStatus(A, s.id, { status: "ACTIVE" })).student.status, "ACTIVE");
  assert.equal(unwrap(await students.changeStatus(A, s.id, { status: "GRADUATED" })).student.status, "GRADUATED");
  assert.equal(errorOf(await students.changeStatus(B, s.id, { status: "ACTIVE" })), "not_found");
});

test("status: withdrawing ends the open enrollment (kept as history); graduating completes it; nothing is deleted", async () => {
  const { students, enrollments, repo, seedSchool } = setup();
  const { year, basic1 } = seedSchool();
  const s = unwrap(await students.register(A, ama));
  const e = unwrap(await enrollments.enroll(A, s.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-10-01" }));
  const result = unwrap(await students.changeStatus(A, s.id, { status: "WITHDRAWN", effectiveDate: "2026-10-20" }));
  assert.deepEqual(result.closedEnrollmentIds, [e.id]);
  const row = repo.enrollments.find((x) => x.id === e.id)!;
  assert.equal(row.status, "WITHDRAWN");
  assert.equal(row.endDate, "2026-10-20");
  assert.equal(repo.enrollments.length, 1, "history kept");
  assert.equal(repo.students.length, 1, "the student is kept");
  assert.deepEqual(unwrap(await enrollments.roster(A, basic1.id, year.id, false)).entries, [], "no longer on the current roster");
  assert.equal(unwrap(await enrollments.roster(A, basic1.id, year.id, true)).entries.length, 1, "still in the history view");
  const events = repo.audit.map((x) => x.action);
  assert.ok(events.includes("student.status_changed") && events.includes("enrollment.ended"));

  const g = unwrap(await students.register(A, { firstName: "Esi", lastName: "Addo" }));
  const e2 = unwrap(await enrollments.enroll(A, g.id, { classId: basic1.id, academicYearId: year.id }));
  unwrap(await students.changeStatus(A, g.id, { status: "GRADUATED" }));
  assert.equal(repo.enrollments.find((x) => x.id === e2.id)!.status, "COMPLETED");
});

test("status: an effective date before the enrollment began is refused and nothing changes", async () => {
  const { students, enrollments, repo, seedSchool } = setup();
  const { year, basic1 } = seedSchool();
  const s = unwrap(await students.register(A, ama));
  unwrap(await enrollments.enroll(A, s.id, { classId: basic1.id, academicYearId: year.id, startDate: "2026-10-01" }));
  assert.equal(errorOf(await students.changeStatus(A, s.id, { status: "WITHDRAWN", effectiveDate: "2026-09-15" })), "validation_error");
  assert.equal(repo.students[0]!.status, "ACTIVE");
  assert.equal(repo.enrollments[0]!.status, "ENROLLED");
});

test("status: a failure part-way leaves the student ACTIVE and the enrollment open (all or nothing)", async () => {
  const { students, enrollments, repo, seedSchool } = setup();
  const { year, basic1 } = seedSchool();
  const s = unwrap(await students.register(A, ama));
  unwrap(await enrollments.enroll(A, s.id, { classId: basic1.id, academicYearId: year.id }));
  const auditBefore = repo.audit.length;
  repo.failNextStatusChange = true;
  await assert.rejects(students.changeStatus(A, s.id, { status: "WITHDRAWN" }), /simulated/);
  assert.equal(repo.students[0]!.status, "ACTIVE");
  assert.equal(repo.enrollments[0]!.status, "ENROLLED");
  assert.equal(repo.enrollments[0]!.endDate, year.endDate);
  assert.equal(repo.audit.length, auditBefore, "no audit for a change that did not happen");
});

test("privacy: a caller without students:sensitive never receives a date of birth; the rest of the record is unchanged", async () => {
  const { students, guardians } = setup();
  const s = unwrap(await students.register(A, { ...ama, dateOfBirth: "2018-05-04", middleName: "Serwaa" }));
  assert.equal(s.dateOfBirth, "2018-05-04", "an allowed caller sees it");
  unwrap(await guardians.link(A, s.id, { guardian: { fullName: "Abena Mensah", phone: "0241234567", email: "abena@example.com" }, relationship: "MOTHER" }));

  const seen = unwrap(await students.profile(RESTRICTED, s.id));
  assert.equal(seen.student.dateOfBirth, null);
  assert.equal(seen.student.firstName, "Ama");
  assert.equal(seen.student.middleName, "Serwaa");
  assert.equal(seen.student.admissionNumber, "2026/0001");
  assert.equal(seen.student.status, "ACTIVE");
  assert.equal(seen.guardians[0]!.fullName, "Abena Mensah");
  assert.equal(seen.guardians[0]!.relationship, "MOTHER");
  assert.equal(seen.guardians[0]!.isPrimaryContact, true);
  assert.equal(seen.guardians[0]!.phone, null);
  assert.equal(seen.guardians[0]!.email, null);
  assert.doesNotMatch(JSON.stringify(seen), /2018-05-04|\+233241234567|abena@example\.com/);

  // The other responses that carry a student record are filtered the same way.
  assert.equal(unwrap(await students.update(RESTRICTED, s.id, { firstName: "Akua" })).dateOfBirth, null);
  assert.equal(unwrap(await students.changeStatus(RESTRICTED, s.id, { status: "WITHDRAWN" })).student.dateOfBirth, null);
  // ...and the stored value was not touched by any of that.
  assert.equal(unwrap(await students.profile(A, s.id)).student.dateOfBirth, "2018-05-04");
});

test("privacy: a caller with no flag at all is treated as NOT allowed (fail closed)", async () => {
  const { students } = setup();
  const s = unwrap(await students.register(A, { ...ama, dateOfBirth: "2018-05-04" }));
  const bare = { schoolId: A.schoolId, userId: A.userId };
  assert.equal(unwrap(await students.profile(bare, s.id)).student.dateOfBirth, null);
});
