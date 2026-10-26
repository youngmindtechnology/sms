import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryAcademicRepository } from "../testing/memoryAcademicRepository.js";
import { createAcademicService, type Actor } from "./academicService.js";
import { isCalendarDate, rangesOverlap } from "./dates.js";

const A: Actor = { schoolId: "10000000-0000-4000-8000-0000000000a1", userId: "20000000-0000-4000-8000-000000000001" };
const B: Actor = { schoolId: "10000000-0000-4000-8000-0000000000b1", userId: "20000000-0000-4000-8000-000000000002" };

function setup() {
  const repo = new MemoryAcademicRepository();
  return { repo, svc: createAcademicService(repo) };
}
const year = { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" };
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; value: T }).value;
};
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

test("calendar dates: real dates only, in a sane range", () => {
  for (const good of ["2026-09-01", "2028-02-29"]) assert.equal(isCalendarDate(good), true, good);
  for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-9-1", "01/09/2026", "2026-09-01T00:00:00Z", "", null, 20260901, "1999-01-01", "2101-01-01"]) {
    assert.equal(isCalendarDate(bad), false, String(bad));
  }
});

test("range overlap is inclusive on both ends", () => {
  assert.equal(rangesOverlap({ startDate: "2026-01-01", endDate: "2026-01-31" }, { startDate: "2026-01-31", endDate: "2026-02-28" }), true);
  assert.equal(rangesOverlap({ startDate: "2026-01-01", endDate: "2026-01-30" }, { startDate: "2026-01-31", endDate: "2026-02-28" }), false);
});

test("create year: trims the name, stores PLANNED, writes an audit event without secrets", async () => {
  const { svc, repo } = setup();
  const created = unwrap(await svc.createYear(A, { ...year, name: "  2026/2027  " }));
  assert.equal(created.name, "2026/2027");
  assert.equal(created.status, "PLANNED");
  assert.equal(repo.audit.length, 1);
  assert.equal(repo.audit[0]!.action, "academic_year.created");
  assert.equal(repo.audit[0]!.schoolId, A.schoolId);
  assert.equal(repo.audit[0]!.actorUserId, A.userId);
});

test("create year: invalid names, dates and ranges are rejected with field messages", async () => {
  const { svc } = setup();
  for (const [input, field] of [
    [{ ...year, name: "" }, "name"], [{ ...year, name: "   " }, "name"], [{ ...year, name: "x".repeat(51) }, "name"], [{ ...year, name: 5 }, "name"],
    [{ ...year, startDate: "2026-02-30" }, "startDate"], [{ ...year, endDate: "soon" }, "endDate"],
    [{ ...year, endDate: year.startDate }, "endDate"], [{ ...year, endDate: "2026-08-01" }, "endDate"],
  ] as const) {
    const r = await svc.createYear(A, input);
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.error, "validation_error"); assert.ok(r.fields?.[field], `expected a message for ${field}`); }
  }
});

test("create year: duplicate name (ignoring case) and overlapping dates are refused inside one school", async () => {
  const { svc } = setup();
  unwrap(await svc.createYear(A, year));
  assert.equal(errorOf(await svc.createYear(A, { ...year, name: "2026/2027", startDate: "2028-09-01", endDate: "2029-07-31" })), "duplicate_name");
  assert.equal(errorOf(await svc.createYear(A, { ...year, name: "2026/2027".toLowerCase(), startDate: "2028-09-01", endDate: "2029-07-31" })), "duplicate_name");
  assert.equal(errorOf(await svc.createYear(A, { name: "Other", startDate: "2027-07-31", endDate: "2028-07-30" })), "dates_overlap");
  assert.equal(errorOf(await svc.createYear(A, { name: "Next", startDate: "2027-08-01", endDate: "2028-07-30" })), "ok");
});

test("two schools can use the same year name and the same dates", async () => {
  const { svc } = setup();
  unwrap(await svc.createYear(A, year));
  unwrap(await svc.createYear(B, year));
  assert.equal((await svc.listYears(A)).length, 1);
  assert.equal((await svc.listYears(B)).length, 1);
});

test("update year: partial change, merges dates, refuses when it would orphan terms or overlap", async () => {
  const { svc } = setup();
  const y = unwrap(await svc.createYear(A, year));
  unwrap(await svc.createYear(A, { name: "2027/2028", startDate: "2027-09-01", endDate: "2028-07-31" }));
  unwrap(await svc.createTerm(A, y.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));

  assert.equal(unwrap(await svc.updateYear(A, y.id, { name: "2026-27" })).name, "2026-27");
  assert.equal(errorOf(await svc.updateYear(A, y.id, { name: "2027/2028" })), "duplicate_name");
  assert.equal(errorOf(await svc.updateYear(A, y.id, { endDate: "2027-09-15" })), "dates_overlap");
  assert.equal(errorOf(await svc.updateYear(A, y.id, { startDate: "2026-10-01" })), "terms_outside_year");
  assert.equal(errorOf(await svc.updateYear(A, y.id, { endDate: "2026-08-01" })), "validation_error");
  assert.equal(errorOf(await svc.updateYear(A, y.id, {})), "validation_error");
  assert.equal(errorOf(await svc.updateYear(A, "30000000-0000-4000-8000-0000000000ff", { name: "Z" })), "not_found");
});

test("activate year: only one ACTIVE year per school; the previous year and its term are closed together", async () => {
  const { svc } = setup();
  const y1 = unwrap(await svc.createYear(A, year));
  const y2 = unwrap(await svc.createYear(A, { name: "2027/2028", startDate: "2027-09-01", endDate: "2028-07-31" }));
  const t1 = unwrap(await svc.createTerm(A, y1.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));

  assert.equal(unwrap(await svc.activateYear(A, y1.id)).status, "ACTIVE");
  unwrap(await svc.activateTerm(A, y1.id, t1.id));
  assert.equal(errorOf(await svc.activateYear(A, y1.id)), "already_active");

  assert.equal(unwrap(await svc.activateYear(A, y2.id)).status, "ACTIVE");
  const years = await svc.listYears(A);
  assert.deepEqual(years.map((y) => [y.name, y.status]).sort(), [["2026/2027", "CLOSED"], ["2027/2028", "ACTIVE"]]);
  assert.equal(years.filter((y) => y.status === "ACTIVE").length, 1);
  assert.equal(unwrap(await svc.listTerms(A, y1.id))[0]!.status, "CLOSED");
  assert.equal(errorOf(await svc.activateYear(A, y1.id)), "period_closed");
});

test("activation is all-or-nothing: a failure part-way leaves the old year and term untouched", async () => {
  const { svc, repo } = setup();
  const y1 = unwrap(await svc.createYear(A, year));
  const y2 = unwrap(await svc.createYear(A, { name: "2027/2028", startDate: "2027-09-01", endDate: "2028-07-31" }));
  const t1 = unwrap(await svc.createTerm(A, y1.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));
  unwrap(await svc.activateYear(A, y1.id));
  unwrap(await svc.activateTerm(A, y1.id, t1.id));
  const auditBefore = repo.audit.length;

  repo.failNextActivation = true;
  await assert.rejects(() => svc.activateYear(A, y2.id), /simulated database failure/);
  const years = await svc.listYears(A);
  assert.equal(years.find((y) => y.id === y1.id)!.status, "ACTIVE");
  assert.equal(years.find((y) => y.id === y2.id)!.status, "PLANNED");
  assert.equal(unwrap(await svc.listTerms(A, y1.id))[0]!.status, "ACTIVE");
  assert.equal(repo.audit.length, auditBefore, "no audit event for a change that did not happen");
});

test("close year: needs an ACTIVE year, closes its active term, and a closed year cannot be edited", async () => {
  const { svc } = setup();
  const y = unwrap(await svc.createYear(A, year));
  assert.equal(errorOf(await svc.closeYear(A, y.id)), "not_active");
  const t = unwrap(await svc.createTerm(A, y.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));
  unwrap(await svc.activateYear(A, y.id));
  unwrap(await svc.activateTerm(A, y.id, t.id));
  assert.equal(unwrap(await svc.closeYear(A, y.id)).status, "CLOSED");
  assert.equal(unwrap(await svc.listTerms(A, y.id))[0]!.status, "CLOSED");
  assert.equal(errorOf(await svc.updateYear(A, y.id, { name: "New" })), "period_closed");
  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "Term 2", startDate: "2027-01-11", endDate: "2027-04-02" })), "period_closed");
});

test("terms: must sit inside the year; name, number and dates cannot collide", async () => {
  const { svc } = setup();
  const y = unwrap(await svc.createYear(A, year));
  const t1 = unwrap(await svc.createTerm(A, y.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));
  assert.equal(t1.sequence, 1, "the number defaults to the next free one");
  assert.equal(unwrap(await svc.createTerm(A, y.id, { name: "Term 2", startDate: "2027-01-11", endDate: "2027-04-02" })).sequence, 2);

  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "Early", startDate: "2026-08-01", endDate: "2026-08-20" })), "outside_year");
  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "Late", startDate: "2027-07-01", endDate: "2027-08-15" })), "outside_year");
  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "term 1", startDate: "2027-05-01", endDate: "2027-06-01" })), "duplicate_name");
  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "Term 9", sequence: 1, startDate: "2027-05-01", endDate: "2027-06-01" })), "duplicate_sequence");
  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "Term 3", startDate: "2027-04-02", endDate: "2027-06-01" })), "dates_overlap");
  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "Term 3", sequence: 0, startDate: "2027-05-01", endDate: "2027-06-01" })), "validation_error");
  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "Term 3", sequence: 1.5, startDate: "2027-05-01", endDate: "2027-06-01" })), "validation_error");
  assert.equal(errorOf(await svc.createTerm(A, y.id, { name: "Term 3", startDate: "2027-06-01", endDate: "2027-05-01" })), "validation_error");
});

test("update term: partial change with the same rules", async () => {
  const { svc } = setup();
  const y = unwrap(await svc.createYear(A, year));
  const t1 = unwrap(await svc.createTerm(A, y.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));
  const t2 = unwrap(await svc.createTerm(A, y.id, { name: "Term 2", startDate: "2027-01-11", endDate: "2027-04-02" }));
  assert.equal(unwrap(await svc.updateTerm(A, y.id, t1.id, { endDate: "2026-12-19" })).endDate, "2026-12-19");
  assert.equal(errorOf(await svc.updateTerm(A, y.id, t1.id, { endDate: "2027-01-11" })), "dates_overlap");
  assert.equal(errorOf(await svc.updateTerm(A, y.id, t1.id, { name: "Term 2" })), "duplicate_name");
  assert.equal(errorOf(await svc.updateTerm(A, y.id, t1.id, { sequence: 2 })), "duplicate_sequence");
  assert.equal(errorOf(await svc.updateTerm(A, y.id, t2.id, { endDate: "2027-09-01" })), "outside_year");
  assert.equal(errorOf(await svc.updateTerm(A, y.id, t2.id, {})), "validation_error");
});

test("activate term: the year must be ACTIVE; only one ACTIVE term per school", async () => {
  const { svc } = setup();
  const y = unwrap(await svc.createYear(A, year));
  const t1 = unwrap(await svc.createTerm(A, y.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));
  const t2 = unwrap(await svc.createTerm(A, y.id, { name: "Term 2", startDate: "2027-01-11", endDate: "2027-04-02" }));
  assert.equal(errorOf(await svc.activateTerm(A, y.id, t1.id)), "year_not_active");
  unwrap(await svc.activateYear(A, y.id));
  assert.equal(unwrap(await svc.activateTerm(A, y.id, t1.id)).status, "ACTIVE");
  assert.equal(errorOf(await svc.activateTerm(A, y.id, t1.id)), "already_active");
  assert.equal(unwrap(await svc.activateTerm(A, y.id, t2.id)).status, "ACTIVE");
  const terms = unwrap(await svc.listTerms(A, y.id));
  assert.deepEqual(terms.map((t) => t.status), ["CLOSED", "ACTIVE"]);
  assert.equal(errorOf(await svc.activateTerm(A, y.id, t1.id)), "period_closed");
  assert.equal(unwrap(await svc.closeTerm(A, y.id, t2.id)).status, "CLOSED");
  assert.equal(errorOf(await svc.closeTerm(A, y.id, t2.id)), "not_active");
});

test("tenant isolation: school B cannot see, change, activate or attach to school A's records", async () => {
  const { svc, repo } = setup();
  const y = unwrap(await svc.createYear(A, year));
  const t = unwrap(await svc.createTerm(A, y.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));
  const snapshot = JSON.stringify([repo.years, repo.terms]);

  assert.deepEqual(await svc.listYears(B), []);
  assert.equal(errorOf(await svc.getYear(B, y.id)), "not_found");
  assert.equal(errorOf(await svc.updateYear(B, y.id, { name: "Hacked" })), "not_found");
  assert.equal(errorOf(await svc.activateYear(B, y.id)), "not_found");
  assert.equal(errorOf(await svc.closeYear(B, y.id)), "not_found");
  assert.equal(errorOf(await svc.listTerms(B, y.id)), "not_found");
  assert.equal(errorOf(await svc.createTerm(B, y.id, { name: "Evil", startDate: "2026-10-01", endDate: "2026-10-10" })), "not_found");
  assert.equal(errorOf(await svc.updateTerm(B, y.id, t.id, { name: "Hacked" })), "not_found");
  assert.equal(errorOf(await svc.activateTerm(B, y.id, t.id)), "not_found");
  assert.equal(errorOf(await svc.closeTerm(B, y.id, t.id)), "not_found");
  assert.equal(JSON.stringify([repo.years, repo.terms]), snapshot, "nothing changed");
});

test("a term id under the wrong year id is not found", async () => {
  const { svc } = setup();
  const y1 = unwrap(await svc.createYear(A, year));
  const y2 = unwrap(await svc.createYear(A, { name: "2027/2028", startDate: "2027-09-01", endDate: "2028-07-31" }));
  const t = unwrap(await svc.createTerm(A, y1.id, { name: "Term 1", startDate: "2026-09-01", endDate: "2026-12-18" }));
  assert.equal(errorOf(await svc.updateTerm(A, y2.id, t.id, { name: "X" })), "not_found");
  assert.equal(errorOf(await svc.closeTerm(A, y2.id, t.id)), "not_found");
});

test("a database refusal (race with another request) becomes a clean conflict, not a crash", async () => {
  const { svc, repo } = setup();
  const original = repo.createYear.bind(repo);
  const { RepositoryConflict } = await import("./ports.js");
  repo.createYear = async () => { throw new RepositoryConflict("overlap"); };
  assert.equal(errorOf(await svc.createYear(A, year)), "dates_overlap");
  repo.createYear = async () => { throw new RepositoryConflict("duplicate"); };
  assert.equal(errorOf(await svc.createYear(A, year)), "duplicate_name");
  repo.createYear = async () => { throw new Error("connection lost"); };
  await assert.rejects(() => svc.createYear(A, year), /connection lost/);
  repo.createYear = original;
});

test("audit events carry ids and names only, and are scoped to the acting school", async () => {
  const { svc, repo } = setup();
  const y = unwrap(await svc.createYear(A, year));
  unwrap(await svc.activateYear(A, y.id));
  unwrap(await svc.closeYear(A, y.id));
  assert.deepEqual(repo.audit.map((e) => e.action), ["academic_year.created", "academic_year.activated", "academic_year.closed"]);
  for (const e of repo.audit) assert.equal(e.schoolId, A.schoolId);
});
