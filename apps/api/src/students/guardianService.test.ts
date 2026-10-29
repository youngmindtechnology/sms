import assert from "node:assert/strict";
import { test } from "node:test";
import { A, B, MISSING, RESTRICTED, ama, errorOf, fieldsOf, setup, unwrap } from "./testKit.js";

async function twoStudents() {
  const kit = setup();
  const ama1 = unwrap(await kit.students.register(A, ama));
  const kofi = unwrap(await kit.students.register(A, { firstName: "Kofi", lastName: "Mensah", admissionNumber: "2026/0002" }));
  return { ...kit, ama1, kofi };
}
const mother = { fullName: "  Abena   Mensah ", phone: "024 123 4567", email: " Abena@Example.com " };

test("create and link: details are cleaned, the phone becomes +233 form, the email is lower-cased, the first guardian is primary", async () => {
  const { guardians, ama1 } = await twoStudents();
  const r = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  assert.equal(r.guardian.fullName, "Abena Mensah");
  assert.equal(r.guardian.phone, "+233241234567");
  assert.equal(r.guardian.email, "abena@example.com");
  assert.equal(r.link.relationship, "MOTHER");
  assert.equal(r.link.isPrimaryContact, true);
  const second = unwrap(await guardians.link(A, ama1.id, { guardian: { fullName: "Kwame Mensah", phone: "+233 20 111 2222" }, relationship: "FATHER" }));
  assert.equal(second.link.isPrimaryContact, false, "later guardians are not primary by default");
});

test("create: a name and at least one way to reach the guardian are required; bad phones and e-mails are refused", async () => {
  const { guardians, ama1, repo } = await twoStudents();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ phone: "0241234567" }, "guardian.fullName"], [{ fullName: "", phone: "0241234567" }, "guardian.fullName"], [{ fullName: "X" }, "guardian.phone"],
    [{ fullName: "X", phone: "12345" }, "guardian.phone"], [{ fullName: "X", phone: "abcdefghij" }, "guardian.phone"], [{ fullName: "X", phone: "+0123456789" }, "guardian.phone"],
    [{ fullName: "X", email: "not-an-email" }, "guardian.email"], [{ fullName: "X", email: "a@b" }, "guardian.email"], [{ fullName: "X", phone: 241234567 }, "guardian.phone"],
  ];
  for (const [guardian, field] of cases) {
    const r = await guardians.link(A, ama1.id, { guardian, relationship: "MOTHER" });
    assert.equal(errorOf(r), "validation_error", JSON.stringify(guardian));
    assert.ok(fieldsOf(r)[field], `expected ${field} for ${JSON.stringify(guardian)}`);
  }
  assert.equal(repo.guardians.length, 0);
  assert.equal(repo.links.length, 0);
});

test("phone numbers: local, international and 00-prefixed forms normalise; the database format is always E.164", async () => {
  const { guardians, ama1 } = await twoStudents();
  for (const [typed, stored] of [["0241234567", "+233241234567"], ["024-123-4567", "+233241234567"], ["233241234567", "+233241234567"], ["+233 24 123 4567", "+233241234567"], ["00233241234567", "+233241234567"], ["+44 20 7946 0958", "+442079460958"]]) {
    const r = unwrap(await guardians.link(A, ama1.id, { guardian: { fullName: "G", phone: typed }, relationship: "OTHER" }));
    assert.equal(r.guardian.phone, stored, typed);
  }
});

test("link: the relationship must be one of the allowed values", async () => {
  const { guardians, ama1 } = await twoStudents();
  for (const relationship of ["MUM", "mother", "", undefined, null, 5]) {
    const r = await guardians.link(A, ama1.id, { guardian: mother, relationship });
    assert.equal(errorOf(r), "validation_error", String(relationship));
    assert.ok(fieldsOf(r).relationship);
  }
  for (const relationship of ["MOTHER", "FATHER", "GRANDPARENT", "SIBLING", "UNCLE_OR_AUNT", "OTHER_RELATIVE", "LEGAL_GUARDIAN", "OTHER"]) {
    unwrap(await guardians.link(A, ama1.id, { guardian: { fullName: "G", phone: "0241234567" }, relationship }));
  }
});

test("link: give an existing guardian OR a new one, never both or neither", async () => {
  const { guardians, ama1 } = await twoStudents();
  const made = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  assert.equal(errorOf(await guardians.link(A, ama1.id, { relationship: "FATHER" })), "validation_error");
  assert.equal(errorOf(await guardians.link(A, ama1.id, { guardianId: made.guardian.id, guardian: mother, relationship: "FATHER" })), "validation_error");
  assert.equal(errorOf(await guardians.link(A, ama1.id, { guardianId: 5, relationship: "FATHER" })), "validation_error");
});

test("siblings: one guardian can be linked to several students, and a duplicate link is refused", async () => {
  const { guardians, ama1, kofi } = await twoStudents();
  const made = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  const again = unwrap(await guardians.link(A, kofi.id, { guardianId: made.guardian.id, relationship: "MOTHER" }));
  assert.equal(again.guardian.id, made.guardian.id, "the same guardian record");
  assert.equal(again.link.isPrimaryContact, true, "first guardian of this child");
  const detail = unwrap(await guardians.detail(A, made.guardian.id));
  assert.deepEqual(detail.students.map((s) => s.firstName).sort(), ["Ama", "Kofi"]);
  const dup = await guardians.link(A, kofi.id, { guardianId: made.guardian.id, relationship: "FATHER" });
  assert.equal(errorOf(dup), "already_linked");
});

test("primary guardian: at most one per student; choosing a new one demotes the old one atomically", async () => {
  const { guardians, students, ama1, repo } = await twoStudents();
  const a = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  const b = unwrap(await guardians.link(A, ama1.id, { guardian: { fullName: "Kwame", phone: "0201112222" }, relationship: "FATHER", isPrimaryContact: true }));
  assert.equal(b.link.isPrimaryContact, true);
  const primaries = () => repo.links.filter((l) => l.studentId === ama1.id && l.isPrimaryContact).map((l) => l.guardianId);
  assert.deepEqual(primaries(), [b.guardian.id]);
  unwrap(await guardians.updateLink(A, ama1.id, a.guardian.id, { isPrimaryContact: true }));
  assert.deepEqual(primaries(), [a.guardian.id]);
  unwrap(await guardians.updateLink(A, ama1.id, a.guardian.id, { isPrimaryContact: false }));
  assert.deepEqual(primaries(), [], "a student may have no primary guardian");
  const profile = unwrap(await students.profile(A, ama1.id));
  assert.equal(profile.guardians.length, 2);
});

test("update link: relationship and primary flag only; validation and 404s", async () => {
  const { guardians, ama1, kofi } = await twoStudents();
  const a = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  assert.equal(unwrap(await guardians.updateLink(A, ama1.id, a.guardian.id, { relationship: "LEGAL_GUARDIAN" })).relationship, "LEGAL_GUARDIAN");
  assert.equal(errorOf(await guardians.updateLink(A, ama1.id, a.guardian.id, { relationship: "PAL" })), "validation_error");
  assert.equal(errorOf(await guardians.updateLink(A, ama1.id, a.guardian.id, { isPrimaryContact: "yes" })), "validation_error");
  assert.equal(errorOf(await guardians.updateLink(A, ama1.id, a.guardian.id, {})), "validation_error");
  assert.equal(errorOf(await guardians.updateLink(A, kofi.id, a.guardian.id, { relationship: "FATHER" })), "not_found", "not linked to that student");
  assert.equal(errorOf(await guardians.updateLink(B, ama1.id, a.guardian.id, { relationship: "FATHER" })), "not_found");
});

test("edit guardian: partial changes, cleaned, must keep a way to reach them; the audit names the fields only", async () => {
  const { guardians, ama1, repo } = await twoStudents();
  const a = unwrap(await guardians.link(A, ama1.id, { guardian: { fullName: "Abena", phone: "0241234567" }, relationship: "MOTHER" }));
  const u = unwrap(await guardians.update(A, a.guardian.id, { email: "ABENA@Example.com", fullName: " Abena  Owusu " }));
  assert.equal(u.email, "abena@example.com");
  assert.equal(u.fullName, "Abena Owusu");
  assert.equal(u.phone, "+233241234567", "untouched");
  assert.deepEqual(repo.audit.at(-1)!.metadata, { changed: ["fullName", "email"] });
  assert.equal(errorOf(await guardians.update(A, a.guardian.id, { phone: "nonsense" })), "validation_error");
  assert.equal(errorOf(await guardians.update(A, a.guardian.id, {})), "validation_error");
  unwrap(await guardians.update(A, a.guardian.id, { phone: null }));
  assert.equal(errorOf(await guardians.update(A, a.guardian.id, { email: null })), "validation_error", "can't remove the last contact detail");
});

test("unlink: removes only the link; the guardian, the student and the other child's link stay; the audit records it", async () => {
  const { guardians, ama1, kofi, repo } = await twoStudents();
  const a = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  unwrap(await guardians.link(A, kofi.id, { guardianId: a.guardian.id, relationship: "MOTHER" }));
  unwrap(await guardians.unlink(A, ama1.id, a.guardian.id));
  assert.equal(repo.guardians.length, 1, "guardian record kept");
  assert.equal(repo.students.length, 2, "students kept");
  assert.deepEqual(repo.links.map((l) => l.studentId), [kofi.id], "the sibling's link is untouched");
  const event = repo.audit.at(-1)!;
  assert.equal(event.action, "student.guardian_unlinked");
  assert.deepEqual(event.metadata, { guardianId: a.guardian.id, relationship: "MOTHER", wasPrimaryContact: true });
  assert.equal(errorOf(await guardians.unlink(A, ama1.id, a.guardian.id)), "not_found", "already unlinked");
});

test("tenant isolation: another school's student and guardian ids behave exactly like missing ones", async () => {
  const { guardians, students, ama1, repo } = await twoStudents();
  const a = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  const outsider = unwrap(await students.register(B, { firstName: "Out", lastName: "Sider" }));
  const snapshot = JSON.stringify([repo.guardians, repo.links]);
  assert.equal(errorOf(await guardians.detail(B, a.guardian.id)), "not_found");
  assert.equal(errorOf(await guardians.update(B, a.guardian.id, { fullName: "Hacked" })), "not_found");
  assert.equal(errorOf(await guardians.link(B, ama1.id, { guardian: mother, relationship: "MOTHER" })), "not_found", "foreign student");
  // A foreign guardian id in the body is just "not a guardian of yours", same as a made-up id.
  const foreign = await guardians.link(B, outsider.id, { guardianId: a.guardian.id, relationship: "MOTHER" });
  const missing = await guardians.link(B, outsider.id, { guardianId: MISSING, relationship: "MOTHER" });
  assert.deepEqual(foreign, missing);
  assert.equal(errorOf(foreign), "validation_error");
  assert.equal(errorOf(await guardians.unlink(B, ama1.id, a.guardian.id)), "not_found");
  assert.deepEqual(unwrap(await guardians.search(B, "abena")), []);
  assert.equal(JSON.stringify([repo.guardians, repo.links]), snapshot, "nothing changed");
});

test("search: needs 2+ characters, matches name or phone, returns this school only", async () => {
  const { guardians, ama1 } = await twoStudents();
  unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  assert.equal(unwrap(await guardians.search(A, "aben")).length, 1);
  assert.equal(unwrap(await guardians.search(A, "+23324")).length, 1);
  assert.equal(unwrap(await guardians.search(A, "zzz")).length, 0);
  assert.equal(errorOf(await guardians.search(A, "a")), "validation_error");
  assert.equal(errorOf(await guardians.search(A, undefined)), "validation_error");
});

test("create and link is all or nothing: a failure leaves no guardian and no link behind", async () => {
  const { guardians, ama1, repo } = await twoStudents();
  const auditBefore = repo.audit.length;
  repo.failNextGuardianCreate = true;
  await assert.rejects(guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }), /simulated/);
  assert.equal(repo.guardians.length, 0);
  assert.equal(repo.links.length, 0);
  assert.equal(repo.audit.length, auditBefore, "no audit for the failed write");
});

test("audit events for guardians never contain names, phone numbers or e-mail addresses", async () => {
  const { guardians, ama1, repo } = await twoStudents();
  repo.audit.length = 0; // drop the two student.created events from setup
  const a = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  unwrap(await guardians.update(A, a.guardian.id, { phone: "0207654321" }));
  unwrap(await guardians.updateLink(A, ama1.id, a.guardian.id, { relationship: "LEGAL_GUARDIAN" }));
  unwrap(await guardians.unlink(A, ama1.id, a.guardian.id));
  const text = JSON.stringify(repo.audit);
  for (const secret of ["Abena", "abena@example.com", "233241234567", "0241234567", "207654321", "Mensah"]) assert.ok(!text.includes(secret), `audit leaked ${secret}`);
  assert.deepEqual(repo.audit.map((e) => e.action), ["guardian.created", "student.guardian_linked", "guardian.updated", "student.guardian_updated", "student.guardian_unlinked"]);
});

test("privacy: a caller without students:sensitive never receives a guardian's phone number or e-mail address", async () => {
  const { guardians, ama1 } = await twoStudents();
  const made = unwrap(await guardians.link(A, ama1.id, { guardian: mother, relationship: "MOTHER" }));
  assert.equal(made.guardian.phone, "+233241234567", "an allowed caller sees it");
  assert.equal(made.guardian.email, "abena@example.com");

  const detail = unwrap(await guardians.detail(RESTRICTED, made.guardian.id));
  assert.equal(detail.guardian.fullName, "Abena Mensah");
  assert.equal(detail.guardian.phone, null);
  assert.equal(detail.guardian.email, null);
  assert.equal(detail.students[0]!.id, ama1.id, "the linked students are still listed");
  assert.equal(detail.students[0]!.relationship, "MOTHER");

  const found = unwrap(await guardians.search(RESTRICTED, "abena"));
  assert.equal(found[0]!.fullName, "Abena Mensah");
  assert.equal(found[0]!.phone, null);
  assert.equal(found[0]!.email, null);
  assert.doesNotMatch(JSON.stringify([detail, found]), /\+233241234567|abena@example\.com/);

  const edited = unwrap(await guardians.update(RESTRICTED, made.guardian.id, { fullName: "Abena K. Mensah" }));
  assert.equal(edited.fullName, "Abena K. Mensah");
  assert.equal(edited.phone, null);
  // The stored contact details were not changed or lost.
  const stored = unwrap(await guardians.detail(A, made.guardian.id)).guardian;
  assert.equal(stored.phone, "+233241234567");
  assert.equal(stored.email, "abena@example.com");
});
