import assert from "node:assert/strict";
import { test } from "node:test";
import { A, B, MISSING, errorOf, fieldsOf, setup, unwrap } from "./testKit.js";
import { SubjectConflict } from "./ports.js";

// ---------------------------------------------------------------- subjects

test("create subject: trims and squeezes the name, upper-cases the code, stores the class, audits ids only", async () => {
  const { service, repo, p4 } = await setup();
  const s = unwrap(await service.createSubject(A, { classId: p4.id, name: "  Integrated   Science ", code: " sci " }));
  assert.equal(s.name, "Integrated Science");
  assert.equal(s.code, "SCI");
  assert.equal(s.classId, p4.id);
  assert.equal(s.isActive, true);
  assert.equal(repo.subjects[0]!.schoolId, A.schoolId);
  const event = repo.audit.at(-1)!;
  assert.equal(event.action, "subject.created");
  assert.deepEqual(event.metadata, { classId: p4.id });
  assert.equal(event.schoolId, A.schoolId);
});

test("create subject: a blank code means no code; several subjects without a code are fine", async () => {
  const { service, p4 } = await setup();
  assert.equal(unwrap(await service.createSubject(A, { classId: p4.id, name: "Art", code: "  " })).code, null);
  assert.equal(unwrap(await service.createSubject(A, { classId: p4.id, name: "Music" })).code, null);
  assert.equal(unwrap(await service.createSubject(A, { classId: p4.id, name: "Drama", code: null })).code, null);
});

test("create subject: blank, missing, long and control-character names are rejected with field messages", async () => {
  const { service, p4, repo } = await setup();
  for (const name of ["", "   ", undefined, 5, "x".repeat(101), "Bad\u0007Name"]) {
    const r = await service.createSubject(A, { classId: p4.id, name });
    assert.equal(errorOf(r), "validation_error", String(name));
    assert.ok(fieldsOf(r).name);
  }
  assert.equal(repo.subjects.length, 0);
});

test("create subject: bad codes are rejected", async () => {
  const { service, p4 } = await setup();
  for (const code of ["x".repeat(21), "<script>", 42]) {
    assert.equal(errorOf(await service.createSubject(A, { classId: p4.id, name: "Maths", code })), "validation_error", String(code));
  }
});

test("create subject: missing, malformed and other-school class ids all look the same (validation error on classId)", async () => {
  const { service, foreignClass } = await setup();
  for (const classId of [undefined, "nope", MISSING, foreignClass.id]) {
    const r = await service.createSubject(A, { classId, name: "Maths" });
    assert.equal(errorOf(r), "validation_error");
    assert.ok(fieldsOf(r).classId);
  }
});

test("create subject: an inactive class is refused", async () => {
  const { service, retired, repo } = await setup();
  assert.equal(errorOf(await service.createSubject(A, { classId: retired.id, name: "Maths" })), "class_inactive");
  assert.equal(repo.subjects.length, 0);
});

test("duplicates: the same name (any case or spacing) or code in one class is refused", async () => {
  const { service, p4 } = await setup();
  unwrap(await service.createSubject(A, { classId: p4.id, name: "Mathematics", code: "MATH" }));
  assert.equal(errorOf(await service.createSubject(A, { classId: p4.id, name: " mathematics " })), "duplicate_name");
  assert.equal(errorOf(await service.createSubject(A, { classId: p4.id, name: "Maths Extra", code: "math" })), "duplicate_code");
});

test("Primary 4 Mathematics and Primary 5 Mathematics are separate records, and so are two schools' subjects", async () => {
  const { service, p4, p5, foreignClass, repo } = await setup();
  const a = unwrap(await service.createSubject(A, { classId: p4.id, name: "Mathematics", code: "MATH" }));
  const b = unwrap(await service.createSubject(A, { classId: p5.id, name: "Mathematics", code: "MATH" }));
  const c = unwrap(await service.createSubject(B, { classId: foreignClass.id, name: "Mathematics", code: "MATH" }));
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.equal(repo.subjects.length, 3);
});

test("a database refusal (a race with another request) becomes a clean conflict; other failures propagate", async () => {
  const { service, repo, p4 } = await setup();
  const original = repo.createSubject.bind(repo);
  repo.createSubject = async () => { throw new SubjectConflict("name"); };
  assert.equal(errorOf(await service.createSubject(A, { classId: p4.id, name: "Maths" })), "duplicate_name");
  repo.createSubject = async () => { throw new SubjectConflict("code"); };
  assert.equal(errorOf(await service.createSubject(A, { classId: p4.id, name: "Maths", code: "M" })), "duplicate_code");
  repo.createSubject = async () => { throw new Error("simulated database failure"); };
  await assert.rejects(service.createSubject(A, { classId: p4.id, name: "Maths" }), /simulated/);
  repo.createSubject = original;
});

test("update subject: partial change, rename and recode collisions, empty and invalid patches", async () => {
  const { service, p4, repo } = await setup();
  const maths = unwrap(await service.createSubject(A, { classId: p4.id, name: "Mathematics", code: "MATH" }));
  const eng = unwrap(await service.createSubject(A, { classId: p4.id, name: "English", code: "ENG" }));
  const renamed = unwrap(await service.updateSubject(A, maths.id, { name: "  Maths  " }));
  assert.equal(renamed.name, "Maths");
  assert.equal(renamed.code, "MATH", "code untouched");
  assert.equal(errorOf(await service.updateSubject(A, maths.id, { name: "english" })), "duplicate_name");
  assert.equal(errorOf(await service.updateSubject(A, maths.id, { code: "eng" })), "duplicate_code");
  assert.equal(unwrap(await service.updateSubject(A, maths.id, { code: null })).code, null, "a code can be cleared");
  assert.equal(unwrap(await service.updateSubject(A, maths.id, { name: "Maths" })).name, "Maths", "keeping its own name is not a clash");
  assert.equal(errorOf(await service.updateSubject(A, maths.id, {})), "validation_error");
  assert.equal(errorOf(await service.updateSubject(A, maths.id, { name: "" })), "validation_error");
  assert.equal(errorOf(await service.updateSubject(A, maths.id, { isActive: "yes" })), "validation_error");
  assert.equal(repo.subjects.find((s) => s.id === eng.id)!.name, "English");
  assert.deepEqual(repo.audit.at(-1)!.metadata, { classId: p4.id, changed: ["name"] });
});

test("deactivating keeps the subject with the same id; it can be reactivated; the audit names the action", async () => {
  const { service, p4, repo } = await setup();
  const s = unwrap(await service.createSubject(A, { classId: p4.id, name: "Maths" }));
  assert.equal(unwrap(await service.updateSubject(A, s.id, { isActive: false })).isActive, false);
  assert.equal(repo.audit.at(-1)!.action, "subject.deactivated");
  assert.equal(repo.subjects.length, 1);
  assert.equal(unwrap(await service.updateSubject(A, s.id, { isActive: true })).id, s.id);
  assert.equal(repo.audit.at(-1)!.action, "subject.reactivated");
  assert.equal(unwrap(await service.listForClass(A, p4.id)).subjects.length, 1, "inactive subjects are still listed");
});

test("the service offers no delete", async () => {
  const { service } = await setup();
  assert.equal(Object.keys(service).some((k) => /delete|remove/i.test(k)), false);
});

test("list: only this class's subjects, ordered by name, with their active teachers for the chosen year", async () => {
  const { service, p4, p5, year, ama } = await setup();
  const maths = unwrap(await service.createSubject(A, { classId: p4.id, name: "Mathematics" }));
  unwrap(await service.createSubject(A, { classId: p4.id, name: "Art" }));
  unwrap(await service.createSubject(A, { classId: p5.id, name: "Other" }));
  unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  const withYear = unwrap(await service.listForClass(A, p4.id, year.id));
  assert.deepEqual(withYear.subjects.map((s) => s.name), ["Art", "Mathematics"]);
  assert.deepEqual(withYear.subjects.map((s) => s.teachers.length), [0, 1]);
  assert.equal(withYear.subjects[1]!.teachers[0]!.teacherName, "Ama Teacher");
  assert.equal(unwrap(await service.listForClass(A, p4.id)).subjects[1]!.teachers.length, 0, "no year, no teachers");
  assert.equal(errorOf(await service.listForClass(A, MISSING)), "not_found");
  assert.equal(errorOf(await service.listForClass(A, p4.id, MISSING)), "not_found");
});

test("school isolation: school B cannot see, list, change, assign or replace anything of school A", async () => {
  const { service, p4, year, ama, foreignTeacher, foreignClass, foreignYear } = await setup();
  const maths = unwrap(await service.createSubject(A, { classId: p4.id, name: "Mathematics" }));
  const a = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  assert.equal(errorOf(await service.listForClass(B, p4.id)), "not_found");
  assert.equal(errorOf(await service.updateSubject(B, maths.id, { name: "Hacked" })), "not_found");
  assert.equal(errorOf(await service.listAssignments(B, maths.id, { includeEnded: true })), "not_found");
  assert.equal(errorOf(await service.assign(B, maths.id, { academicYearId: foreignYear.id, teacherMembershipId: foreignTeacher.membershipId })), "not_found");
  assert.equal(errorOf(await service.replace(B, a.id, { teacherMembershipId: foreignTeacher.membershipId })), "not_found");
  assert.equal(errorOf(await service.end(B, a.id)), "not_found");
  assert.equal(unwrap(await service.listForClass(B, foreignClass.id)).subjects.length, 0);
  assert.equal((await service.eligibleTeachers(B)).map((t) => t.fullName).join(), "Foreign Teacher");
});

// ------------------------------------------------------------- assignments

async function withMaths() {
  const ctx = await setup();
  const maths = unwrap(await ctx.service.createSubject(A, { classId: ctx.p4.id, name: "Mathematics", code: "MATH" }));
  return { ...ctx, maths };
}

test("assign: an eligible teacher gets an ACTIVE assignment for the subject and year; the audit holds ids only", async () => {
  const { service, repo, maths, year, ama } = await withMaths();
  const a = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  assert.equal(a.status, "ACTIVE");
  assert.equal(a.endedAt, null);
  assert.equal(a.teacherName, "Ama Teacher");
  assert.equal(a.teacherMembershipId, ama.membershipId);
  assert.equal(a.academicYearName, "2026/2027");
  assert.equal(JSON.stringify(a).includes(ama.user.email), false, "no e-mail in the response");
  assert.equal(JSON.stringify(a).includes(ama.user.id), false, "no user id in the response");
  const event = repo.audit.at(-1)!;
  assert.equal(event.action, "teaching_assignment.created");
  assert.equal(event.entityType, "teaching_assignment");
  assert.equal(event.entityId, a.id);
  assert.deepEqual(event.metadata, { subjectId: maths.id, academicYearId: year.id, teacherMembershipId: ama.membershipId });
  assert.equal(JSON.stringify(event).includes("Ama"), false, "no personal data in the audit");
});

test("assign: planned and active years are allowed, a closed year is refused", async () => {
  const { service, maths, year, nextYear, oldYear, ama, repo } = await withMaths();
  unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  unwrap(await service.assign(A, maths.id, { academicYearId: nextYear.id, teacherMembershipId: ama.membershipId }));
  const before = repo.assignments.length;
  assert.equal(errorOf(await service.assign(A, maths.id, { academicYearId: oldYear.id, teacherMembershipId: ama.membershipId })), "year_closed");
  assert.equal(repo.assignments.length, before);
});

test("assign: several teachers may teach the same subject in the same year", async () => {
  const { service, maths, year, ama, kofi } = await withMaths();
  unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: kofi.membershipId }));
  assert.equal(unwrap(await service.listAssignments(A, maths.id, { academicYearId: year.id, includeEnded: false })).length, 2);
});

test("assign: the same teacher twice for one subject and year is refused; another subject or year is fine", async () => {
  const { service, maths, p4, year, nextYear, ama, repo } = await withMaths();
  const eng = unwrap(await service.createSubject(A, { classId: p4.id, name: "English" }));
  unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  const second = await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId });
  assert.equal(errorOf(second), "already_assigned");
  assert.ok(fieldsOf(second).teacherMembershipId);
  assert.equal(repo.assignments.length, 1);
  unwrap(await service.assign(A, eng.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  unwrap(await service.assign(A, maths.id, { academicYearId: nextYear.id, teacherMembershipId: ama.membershipId }));
});

test("assign: a teacher from another school, a made-up id and junk are rejected the same way", async () => {
  const { service, maths, year, foreignTeacher, repo } = await withMaths();
  for (const id of [foreignTeacher.membershipId, MISSING, "nope", undefined, 7]) {
    const r = await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: id });
    assert.equal(errorOf(r), "validation_error", String(id));
    assert.ok(fieldsOf(r).teacherMembershipId);
  }
  assert.equal(repo.assignments.length, 0);
});

test("assign: suspended, ended, invited and disabled people and non-teachers cannot be assigned", async () => {
  const { service, maths, year, suspended, ended, invited, disabled, bursar, head, repo } = await withMaths();
  for (const who of [suspended, ended, invited, disabled, bursar, head]) {
    assert.equal(errorOf(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: who.membershipId })), "teacher_not_eligible");
  }
  assert.equal(repo.assignments.length, 0);
  assert.deepEqual((await service.eligibleTeachers(A)).map((t) => t.fullName), ["Ama Teacher", "Kofi Teacher"]);
});

test("assign: a missing subject, another school's year and an inactive subject are refused", async () => {
  const { service, maths, year, foreignYear, ama, repo } = await withMaths();
  assert.equal(errorOf(await service.assign(A, MISSING, { academicYearId: year.id, teacherMembershipId: ama.membershipId })), "not_found");
  const foreign = await service.assign(A, maths.id, { academicYearId: foreignYear.id, teacherMembershipId: ama.membershipId });
  assert.equal(errorOf(foreign), "validation_error");
  assert.ok(fieldsOf(foreign).academicYearId);
  unwrap(await service.updateSubject(A, maths.id, { isActive: false }));
  assert.equal(errorOf(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId })), "subject_inactive");
  assert.equal(repo.assignments.length, 0);
});

test("assign: a teacher suspended after the check (a race) is caught by the repository re-check", async () => {
  const { service, maths, year, ama, repo, auth } = await withMaths();
  const original = repo.findTeacher.bind(repo);
  repo.findTeacher = async (schoolId, id) => {
    const found = await original(schoolId, id);
    auth.memberships.get(ama.user.id)![0]!.status = "SUSPENDED"; // happens right after the service looked
    return found;
  };
  assert.equal(errorOf(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId })), "teacher_not_eligible");
  assert.equal(repo.assignments.length, 0);
  assert.equal(repo.audit.filter((e) => e.action === "teaching_assignment.created").length, 0);
});

test("assign: a database duplicate (two requests at once) becomes a clean conflict", async () => {
  const { service, maths, year, ama, repo } = await withMaths();
  repo.createAssignment = async () => { throw new SubjectConflict("assignment"); };
  assert.equal(errorOf(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId })), "already_assigned");
});

test("assign is all or nothing: a failure part-way leaves no assignment and no audit event", async () => {
  const { service, maths, year, ama, repo } = await withMaths();
  const auditBefore = repo.audit.length;
  repo.failNextCreate = true;
  await assert.rejects(service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }), /simulated/);
  assert.equal(repo.assignments.length, 0);
  assert.equal(repo.audit.length, auditBefore);
});

test("end: the assignment becomes ENDED with an end time and stays stored; ending twice is refused", async () => {
  const { service, maths, year, ama, repo } = await withMaths();
  const a = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  const ended = unwrap(await service.end(A, a.id));
  assert.equal(ended.id, a.id);
  assert.equal(ended.status, "ENDED");
  assert.equal(ended.endedAt, "2026-10-27T10:00:00.000Z");
  assert.equal(repo.assignments.length, 1, "history kept");
  assert.equal(repo.audit.at(-1)!.action, "teaching_assignment.ended");
  assert.equal(errorOf(await service.end(A, a.id)), "assignment_ended");
  assert.equal(unwrap(await service.listAssignments(A, maths.id, { includeEnded: false })).length, 0);
  assert.equal(unwrap(await service.listAssignments(A, maths.id, { includeEnded: true })).length, 1);
});

test("end: allowed even when the teacher has since been suspended or the year closed", async () => {
  const { service, maths, year, ama, kofi, repo, auth } = await withMaths();
  const a = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  const b = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: kofi.membershipId }));
  auth.memberships.get(ama.user.id)![0]!.status = "SUSPENDED";
  repo.years.find((y) => y.id === year.id)!.status = "CLOSED";
  assert.equal(unwrap(await service.end(A, a.id)).status, "ENDED");
  assert.equal(unwrap(await service.end(A, b.id)).status, "ENDED");
});

test("after ending, the same teacher can be assigned again as a new record; the old one stays as history", async () => {
  const { service, maths, year, ama, repo } = await withMaths();
  const first = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  unwrap(await service.end(A, first.id));
  const second = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  assert.notEqual(second.id, first.id);
  assert.equal(repo.assignments.length, 2);
  assert.deepEqual(unwrap(await service.listAssignments(A, maths.id, { includeEnded: true })).map((x) => x.status).sort(), ["ACTIVE", "ENDED"]);
});

test("replace: ends the old assignment and starts the new teacher's; history and a single audit event", async () => {
  const { service, maths, year, ama, kofi, repo } = await withMaths();
  const old = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  const result = unwrap(await service.replace(A, old.id, { teacherMembershipId: kofi.membershipId }));
  assert.equal(result.ended.id, old.id);
  assert.equal(result.ended.status, "ENDED");
  assert.notEqual(result.created.id, old.id);
  assert.equal(result.created.status, "ACTIVE");
  assert.equal(result.created.teacherName, "Kofi Teacher");
  assert.equal(result.created.subjectId, maths.id);
  assert.equal(result.created.academicYearId, year.id);
  assert.equal(repo.assignments.length, 2);
  const event = repo.audit.at(-1)!;
  assert.equal(event.action, "teaching_assignment.replaced");
  assert.equal(event.entityId, result.created.id);
  assert.deepEqual(event.metadata, {
    subjectId: maths.id, academicYearId: year.id, fromAssignmentId: old.id,
    fromTeacherMembershipId: ama.membershipId, toTeacherMembershipId: kofi.membershipId,
  });
  assert.equal(repo.audit.filter((e) => e.entityType === "teaching_assignment").length, 2, "created + replaced");
});

test("replace is atomic: if starting the new assignment fails, the old one is still ACTIVE and nothing is audited", async () => {
  const { service, maths, year, ama, kofi, repo } = await withMaths();
  const old = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  const before = JSON.stringify(repo.assignments);
  const auditBefore = repo.audit.length;
  repo.failNextReplace = true;
  await assert.rejects(service.replace(A, old.id, { teacherMembershipId: kofi.membershipId }), /simulated/);
  assert.equal(JSON.stringify(repo.assignments), before);
  assert.equal(repo.assignments[0]!.status, "ACTIVE");
  assert.equal(repo.audit.length, auditBefore);
});

test("replace is atomic when the database refuses the new row (duplicate): the old assignment stays ACTIVE", async () => {
  const { service, maths, year, ama, kofi, repo } = await withMaths();
  const old = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  // Kofi gets an active row between the service's check and the write.
  const original = repo.listAssignments.bind(repo);
  repo.listAssignments = async (...args) => { repo.listAssignments = original; const rows = await original(...args); await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: kofi.membershipId }); return rows; };
  const result = await service.replace(A, old.id, { teacherMembershipId: kofi.membershipId });
  assert.equal(errorOf(result), "already_assigned");
  assert.equal(repo.assignments.find((a) => a.id === old.id)!.status, "ACTIVE");
});

test("replace: refuses the same teacher, an ineligible or foreign teacher, an ended assignment, a closed year and an inactive subject", async () => {
  const { service, maths, year, ama, kofi, suspended, foreignTeacher, repo } = await withMaths();
  const old = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  assert.equal(errorOf(await service.replace(A, old.id, { teacherMembershipId: ama.membershipId })), "validation_error");
  assert.equal(errorOf(await service.replace(A, old.id, { teacherMembershipId: suspended.membershipId })), "teacher_not_eligible");
  assert.equal(errorOf(await service.replace(A, old.id, { teacherMembershipId: foreignTeacher.membershipId })), "validation_error");
  assert.equal(errorOf(await service.replace(A, old.id, { teacherMembershipId: "junk" })), "validation_error");
  assert.equal(errorOf(await service.replace(A, MISSING, { teacherMembershipId: kofi.membershipId })), "not_found");
  repo.years.find((y) => y.id === year.id)!.status = "CLOSED";
  assert.equal(errorOf(await service.replace(A, old.id, { teacherMembershipId: kofi.membershipId })), "year_closed");
  repo.years.find((y) => y.id === year.id)!.status = "ACTIVE";
  unwrap(await service.updateSubject(A, maths.id, { isActive: false }));
  assert.equal(errorOf(await service.replace(A, old.id, { teacherMembershipId: kofi.membershipId })), "subject_inactive");
  unwrap(await service.updateSubject(A, maths.id, { isActive: true }));
  unwrap(await service.end(A, old.id));
  assert.equal(errorOf(await service.replace(A, old.id, { teacherMembershipId: kofi.membershipId })), "assignment_ended");
  assert.equal(repo.assignments.length, 1, "nothing was created by the refused calls");
});

test("replace: a stale screen (the assignment was ended by someone else first) is a clean conflict", async () => {
  const { service, maths, year, ama, kofi, repo } = await withMaths();
  const old = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  const original = repo.findAssignment.bind(repo);
  repo.findAssignment = async (s, id) => { repo.findAssignment = original; const found = await original(s, id); await repo.endAssignment(s, id, new Date(), { actorUserId: A.userId, action: "teaching_assignment.ended", metadata: {} }); return found; };
  assert.equal(errorOf(await service.replace(A, old.id, { teacherMembershipId: kofi.membershipId })), "assignment_ended");
  assert.equal(repo.assignments.length, 1, "no second row was created");
});

test("audit events never hold a name, e-mail, password, hash or token", async () => {
  const { service, maths, year, ama, kofi, repo } = await withMaths();
  const a = unwrap(await service.assign(A, maths.id, { academicYearId: year.id, teacherMembershipId: ama.membershipId }));
  unwrap(await service.replace(A, a.id, { teacherMembershipId: kofi.membershipId }));
  const created = repo.assignments.find((x) => x.status === "ACTIVE")!;
  unwrap(await service.end(A, created.id));
  unwrap(await service.updateSubject(A, maths.id, { name: "Maths" }));
  const text = JSON.stringify(repo.audit);
  for (const secret of ["Ama", "Kofi", "@example.test", "password", "hash", "token", "Mathematics", "Maths"]) assert.equal(text.includes(secret), false, secret);
  assert.ok(repo.audit.length >= 5);
  assert.ok(repo.audit.every((e) => e.schoolId === A.schoolId));
});
