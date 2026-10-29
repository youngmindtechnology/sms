import assert from "node:assert/strict";
import { MemoryStudentRepository } from "../testing/memoryStudentRepository.js";
import { createEnrollmentService } from "./enrollmentService.js";
import { createGuardianService } from "./guardianService.js";
import { createStudentService } from "./studentService.js";
import type { Actor } from "./common.js";

/** Shared by the students, guardians and enrollments unit tests. */
export const A: Actor = { schoolId: "10000000-0000-4000-8000-0000000000a1", userId: "20000000-0000-4000-8000-000000000001", canViewSensitive: true };
export const B: Actor = { schoolId: "10000000-0000-4000-8000-0000000000b1", userId: "20000000-0000-4000-8000-000000000002", canViewSensitive: true };
/** A Teacher or Bursar: may read students and guardians, but not dates of birth or guardian contact details. */
export const RESTRICTED: Actor = { ...A, userId: "20000000-0000-4000-8000-000000000003", canViewSensitive: false };
export const MISSING = "40000000-0000-4000-8000-0000000000ff";
export const TODAY = new Date("2026-10-27T10:00:00.000Z");

export function setup(today: Date = TODAY) {
  const repo = new MemoryStudentRepository();
  const now = () => today;
  return {
    repo,
    students: createStudentService(repo, now),
    guardians: createGuardianService(repo),
    enrollments: createEnrollmentService(repo, now),
    /** A school with one ACTIVE year (2026-09-01 to 2027-07-31) and two active classes. */
    seedSchool(actor: Actor = A) {
      const year = repo.seedYear(actor.schoolId, { name: "2026/2027", status: "ACTIVE", startDate: "2026-09-01", endDate: "2027-07-31" });
      return { year, basic1: repo.seedClass(actor.schoolId, "Basic 1"), basic2: repo.seedClass(actor.schoolId, "Basic 2") };
    },
  };
}

export const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; value: T }).value; };
export const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
export const fieldsOf = (r: { ok: boolean; fields?: Record<string, string> }) => (r.ok ? {} : r.fields ?? {});

export const ama = { firstName: "Ama", lastName: "Mensah", admissionNumber: "2026/0001" };
