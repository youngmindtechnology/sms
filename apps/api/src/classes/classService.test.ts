import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositoryConflict } from "../academic/ports.js";
import { MemoryClassRepository } from "../testing/memoryClassRepository.js";
import { createClassService, type Actor } from "./classService.js";

const A: Actor = { schoolId: "10000000-0000-4000-8000-0000000000a1", userId: "20000000-0000-4000-8000-000000000001" };
const B: Actor = { schoolId: "10000000-0000-4000-8000-0000000000b1", userId: "20000000-0000-4000-8000-000000000002" };

const setup = () => { const repo = new MemoryClassRepository(); return { repo, svc: createClassService(repo) }; };
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; value: T }).value; };
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);

test("create: trims and squeezes the name, accepts all four levels, defaults the order to the next number", async () => {
  const { svc, repo } = setup();
  const a = unwrap(await svc.createClass(A, { name: "  Nursery   1 ", level: "NURSERY" }));
  assert.equal(a.name, "Nursery 1");
  assert.equal(a.sortOrder, 1);
  assert.equal(a.isActive, true);
  assert.equal(unwrap(await svc.createClass(A, { name: "KG 1", level: "KINDERGARTEN" })).sortOrder, 2);
  assert.equal(unwrap(await svc.createClass(A, { name: "Basic 1A", level: "PRIMARY", sortOrder: 0 })).sortOrder, 0);
  assert.equal(unwrap(await svc.createClass(A, { name: "JHS 1", level: "JHS", sortOrder: 10000 })).level, "JHS");
  assert.equal(repo.audit[0]!.action, "class.created");
  assert.equal(repo.audit[0]!.schoolId, A.schoolId);
});

test("create: invalid names, levels and orders are rejected with field messages", async () => {
  const { svc } = setup();
  for (const [input, field] of [
    [{ name: "", level: "PRIMARY" }, "name"], [{ name: "   ", level: "PRIMARY" }, "name"], [{ name: "x".repeat(101), level: "PRIMARY" }, "name"],
    [{ name: 5, level: "PRIMARY" }, "name"], [{ name: "Bad\u0007name", level: "PRIMARY" }, "name"],
    [{ name: "Basic 1", level: "SENIOR" }, "level"], [{ name: "Basic 1", level: "kg" }, "level"], [{ name: "Basic 1", level: undefined }, "level"], [{ name: "Basic 1", level: null }, "level"],
    [{ name: "Basic 1", level: "PRIMARY", sortOrder: -1 }, "sortOrder"], [{ name: "Basic 1", level: "PRIMARY", sortOrder: 1.5 }, "sortOrder"],
    [{ name: "Basic 1", level: "PRIMARY", sortOrder: 10001 }, "sortOrder"], [{ name: "Basic 1", level: "PRIMARY", sortOrder: "3" }, "sortOrder"],
    [{ name: "Basic 1", level: "PRIMARY", sortOrder: Number.NaN }, "sortOrder"],
  ] as const) {
    const r = await svc.createClass(A, input);
    assert.equal(r.ok, false, JSON.stringify(input));
    if (!r.ok) { assert.equal(r.error, "validation_error"); assert.ok(r.fields?.[field], `expected a message for ${field}`); }
  }
  assert.deepEqual(await svc.listClasses(A), [], "nothing was stored");
});

test("duplicate names are refused inside a school (ignoring case and spacing) but allowed in another school", async () => {
  const { svc } = setup();
  unwrap(await svc.createClass(A, { name: "Basic 1A", level: "PRIMARY" }));
  assert.equal(errorOf(await svc.createClass(A, { name: "basic 1a", level: "PRIMARY" })), "duplicate_name");
  assert.equal(errorOf(await svc.createClass(A, { name: " Basic   1A ", level: "JHS" })), "duplicate_name");
  unwrap(await svc.createClass(B, { name: "Basic 1A", level: "PRIMARY" }));
  assert.equal((await svc.listClasses(A)).length, 1);
  assert.equal((await svc.listClasses(B)).length, 1);
});

test("update: partial changes, rename collisions, empty and invalid patches", async () => {
  const { svc } = setup();
  const a = unwrap(await svc.createClass(A, { name: "Basic 1A", level: "PRIMARY" }));
  unwrap(await svc.createClass(A, { name: "Basic 1B", level: "PRIMARY" }));
  assert.equal(unwrap(await svc.updateClass(A, a.id, { name: "Basic 2A" })).name, "Basic 2A");
  assert.equal(unwrap(await svc.updateClass(A, a.id, { level: "JHS", sortOrder: 7 })).level, "JHS");
  assert.equal(unwrap(await svc.updateClass(A, a.id, { name: "basic 2a" })).name, "basic 2a", "re-casing your own name is fine");
  assert.equal(errorOf(await svc.updateClass(A, a.id, { name: "Basic 1B" })), "duplicate_name");
  assert.equal(errorOf(await svc.updateClass(A, a.id, {})), "validation_error");
  assert.equal(errorOf(await svc.updateClass(A, a.id, { level: "OTHER" })), "validation_error");
  assert.equal(errorOf(await svc.updateClass(A, a.id, { sortOrder: -5 })), "validation_error");
  assert.equal(errorOf(await svc.updateClass(A, a.id, { isActive: "yes" })), "validation_error");
  assert.equal(errorOf(await svc.updateClass(A, "40000000-0000-4000-8000-0000000000ff", { name: "Z" })), "not_found");
});

test("deactivating keeps the class stored with the same id; it can be reactivated", async () => {
  const { svc, repo } = setup();
  const a = unwrap(await svc.createClass(A, { name: "Basic 1A", level: "PRIMARY" }));
  const off = unwrap(await svc.updateClass(A, a.id, { isActive: false }));
  assert.equal(off.isActive, false);
  assert.equal(off.id, a.id);
  const listed = await svc.listClasses(A);
  assert.equal(listed.length, 1, "inactive classes are still listed");
  assert.equal(listed[0]!.id, a.id);
  assert.equal(repo.rows.length, 1);
  assert.equal(unwrap(await svc.updateClass(A, a.id, { isActive: true })).isActive, true);
  assert.deepEqual(repo.audit.map((e) => e.action), ["class.created", "class.deactivated", "class.activated"]);
});

test("the service offers no delete", async () => {
  const { svc } = setup();
  assert.deepEqual(Object.keys(svc).sort(), ["createClass", "listClasses", "reorderClasses", "updateClass"]);
});

test("reorder: renumbers 1..n in the given order and lists in that order", async () => {
  const { svc } = setup();
  const a = unwrap(await svc.createClass(A, { name: "Nursery 1", level: "NURSERY" }));
  const b = unwrap(await svc.createClass(A, { name: "KG 1", level: "KINDERGARTEN" }));
  const c = unwrap(await svc.createClass(A, { name: "Basic 1A", level: "PRIMARY" }));
  const result = unwrap(await svc.reorderClasses(A, [c.id, a.id, b.id]));
  assert.deepEqual(result.map((x) => [x.name, x.sortOrder]), [["Basic 1A", 1], ["Nursery 1", 2], ["KG 1", 3]]);
  assert.deepEqual((await svc.listClasses(A)).map((x) => x.name), ["Basic 1A", "Nursery 1", "KG 1"]);
});

test("reorder: lists that are stale, partial, duplicated, foreign or malformed are refused and change nothing", async () => {
  const { svc, repo } = setup();
  const a = unwrap(await svc.createClass(A, { name: "Nursery 1", level: "NURSERY" }));
  const b = unwrap(await svc.createClass(A, { name: "KG 1", level: "KINDERGARTEN" }));
  const other = unwrap(await svc.createClass(B, { name: "Other", level: "JHS" }));
  const before = JSON.stringify(repo.rows);
  assert.equal(errorOf(await svc.reorderClasses(A, [a.id])), "order_mismatch", "partial");
  assert.equal(errorOf(await svc.reorderClasses(A, [a.id, b.id, other.id])), "order_mismatch", "extra");
  assert.equal(errorOf(await svc.reorderClasses(A, [a.id, other.id])), "order_mismatch", "another school's class");
  assert.equal(errorOf(await svc.reorderClasses(A, [])), "order_mismatch", "empty");
  assert.equal(errorOf(await svc.reorderClasses(A, [a.id, a.id])), "validation_error", "duplicate");
  assert.equal(errorOf(await svc.reorderClasses(A, "nope")), "validation_error");
  assert.equal(errorOf(await svc.reorderClasses(A, [1, 2])), "validation_error");
  assert.equal(JSON.stringify(repo.rows), before);
});

test("reorder is all-or-nothing: a failure part-way leaves the old order", async () => {
  const { svc, repo } = setup();
  const a = unwrap(await svc.createClass(A, { name: "Nursery 1", level: "NURSERY" }));
  const b = unwrap(await svc.createClass(A, { name: "KG 1", level: "KINDERGARTEN" }));
  const c = unwrap(await svc.createClass(A, { name: "Basic 1A", level: "PRIMARY" }));
  const auditBefore = repo.audit.length;
  repo.failNextReorder = true;
  await assert.rejects(() => svc.reorderClasses(A, [c.id, b.id, a.id]), /simulated database failure/);
  assert.deepEqual((await svc.listClasses(A)).map((x) => x.name), ["Nursery 1", "KG 1", "Basic 1A"]);
  assert.equal(repo.audit.length, auditBefore);
});

test("tenant isolation: school B cannot see, change or reorder school A's classes", async () => {
  const { svc, repo } = setup();
  const a = unwrap(await svc.createClass(A, { name: "Basic 1A", level: "PRIMARY" }));
  const before = JSON.stringify(repo.rows);
  assert.deepEqual(await svc.listClasses(B), []);
  assert.equal(errorOf(await svc.updateClass(B, a.id, { name: "Hacked" })), "not_found");
  assert.equal(errorOf(await svc.updateClass(B, a.id, { isActive: false })), "not_found");
  assert.equal(errorOf(await svc.reorderClasses(B, [a.id])), "order_mismatch");
  assert.equal(JSON.stringify(repo.rows), before);
});

test("a database refusal (race) becomes a clean conflict; other failures propagate", async () => {
  const { svc, repo } = setup();
  repo.createClass = async () => { throw new RepositoryConflict("duplicate"); };
  assert.equal(errorOf(await svc.createClass(A, { name: "X", level: "JHS" })), "duplicate_name");
  repo.createClass = async () => { throw new Error("connection lost"); };
  await assert.rejects(() => svc.createClass(A, { name: "X", level: "JHS" }), /connection lost/);
});
