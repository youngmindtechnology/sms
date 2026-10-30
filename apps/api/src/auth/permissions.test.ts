import assert from "node:assert/strict";
import { test } from "node:test";
import { can, PERMISSIONS, permissionsFor } from "./permissions.js";

test("OWNER has every permission", () => {
  for (const p of PERMISSIONS) assert.equal(can(["OWNER"], p), true, p);
});

test("unknown roles and empty role lists grant nothing (deny by default)", () => {
  assert.equal(permissionsFor([]).size, 0);
  assert.equal(permissionsFor(["SUPERUSER", "admin", ""]).size, 0);
});

test("a teacher can work with academics but not money, staff or settings", () => {
  assert.equal(can(["TEACHER"], "academics:write"), true);
  for (const p of ["fees:manage", "payments:record", "staff:manage", "school:settings", "audit:read"] as const) {
    assert.equal(can(["TEACHER"], p), false, p);
  }
});

test("a bursar can record payments but cannot change students or academics", () => {
  assert.equal(can(["BURSAR"], "payments:record"), true);
  assert.equal(can(["BURSAR"], "students:write"), false);
  assert.equal(can(["BURSAR"], "academics:write"), false);
});

test("several roles combine", () => {
  assert.equal(can(["TEACHER", "BURSAR"], "payments:record"), true);
  assert.equal(can(["TEACHER", "BURSAR"], "staff:manage"), false);
});

test("only owner, headteacher and administrator can manage the academic calendar; teachers can read it", () => {
  for (const role of ["OWNER", "HEADTEACHER", "ADMINISTRATOR"]) assert.equal(can([role], "calendar:manage"), true, role);
  for (const role of ["TEACHER", "BURSAR"]) assert.equal(can([role], "calendar:manage"), false, role);
  assert.equal(can(["TEACHER"], "academics:read"), true);
  assert.equal(can(["BURSAR"], "academics:read"), false);
});

test("only owner, headteacher and administrator can manage classes; every role can read school data", () => {
  for (const role of ["OWNER", "HEADTEACHER", "ADMINISTRATOR"]) assert.equal(can([role], "classes:manage"), true, role);
  for (const role of ["TEACHER", "BURSAR"]) assert.equal(can([role], "classes:manage"), false, role);
  for (const role of ["OWNER", "HEADTEACHER", "ADMINISTRATOR", "TEACHER", "BURSAR"]) assert.equal(can([role], "school:read"), true, role);
});

test("only owner, headteacher and administrator can see dates of birth and guardian contact details", () => {
  for (const role of ["OWNER", "HEADTEACHER", "ADMINISTRATOR"]) assert.equal(can([role], "students:sensitive"), true, role);
  for (const role of ["TEACHER", "BURSAR"]) {
    assert.equal(can([role], "students:sensitive"), false, role);
    assert.equal(can([role], "students:read"), true, `${role} can still read students`);
  }
});

test("subjects: only owner, headteacher and administrator can manage subjects and assign teachers; teachers can read, bursars cannot", () => {
  for (const role of ["OWNER", "HEADTEACHER", "ADMINISTRATOR"]) {
    assert.equal(can([role], "subjects:manage"), true, role);
    assert.equal(can([role], "subjects:assign"), true, role);
  }
  for (const role of ["TEACHER", "BURSAR"]) {
    assert.equal(can([role], "subjects:manage"), false, role);
    assert.equal(can([role], "subjects:assign"), false, role);
  }
  assert.equal(can(["TEACHER"], "academics:read"), true);
  assert.equal(can(["BURSAR"], "academics:read"), false);
  assert.equal(can(["TEACHER", "BURSAR"], "subjects:manage"), false, "combining two weak roles grants nothing new");
});

test("the subjects phase changed no existing permission: every role keeps exactly its earlier set", () => {
  const NEW = new Set(["subjects:manage", "subjects:assign"]);
  const before = (role: string) => [...permissionsFor([role])].filter((p) => !NEW.has(p)).sort();
  assert.deepEqual(before("HEADTEACHER"), PERMISSIONS.filter((p) => !NEW.has(p) && p !== "staff:manage").sort());
  assert.deepEqual(before("ADMINISTRATOR"), [
    "academics:read", "academics:write", "calendar:manage", "classes:manage", "fees:read", "school:read", "staff:manage", "students:read", "students:sensitive", "students:write",
  ].sort());
  assert.deepEqual(before("TEACHER"), ["academics:read", "academics:write", "school:read", "students:read"].sort());
  assert.deepEqual(before("BURSAR"), ["fees:manage", "fees:read", "payments:record", "school:read", "students:read"].sort());
});
