import assert from "node:assert/strict";
import { hashPassword } from "../auth/password.js";
import { MemoryRepository } from "../testing/memoryRepository.js";
import { MemorySubjectRepository } from "../testing/memorySubjectRepository.js";
import { createSubjectService } from "./subjectService.js";
import type { Actor } from "./subjectService.js";

export const SCHOOL_A = "10000000-0000-4000-8000-0000000000a1";
export const SCHOOL_B = "10000000-0000-4000-8000-0000000000b1";
export const A: Actor = { schoolId: SCHOOL_A, userId: "20000000-0000-4000-8000-000000000001" };
export const B: Actor = { schoolId: SCHOOL_B, userId: "20000000-0000-4000-8000-000000000002" };
export const MISSING = "40000000-0000-4000-8000-0000000000ff";
export const NOW = new Date("2026-10-27T10:00:00.000Z");

type Role = "OWNER" | "HEADTEACHER" | "ADMINISTRATOR" | "TEACHER" | "BURSAR";

/** One school (A) with an active year, two classes and teachers; a second school (B) with its own teacher. */
export async function setup() {
  const auth = new MemoryRepository();
  const repo = new MemorySubjectRepository(auth, () => NOW);
  const service = createSubjectService(repo, () => NOW);
  const { hash, algorithm } = await hashPassword("correct horse battery staple", { algorithm: "scrypt", fast: true });

  const person = (name: string, schoolId: string, roles: Role[], status: "ACTIVE" | "SUSPENDED" | "ENDED" | "INVITED" = "ACTIVE", userStatus: "ACTIVE" | "DISABLED" = "ACTIVE") => {
    const user = auth.addUser({ email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`, fullName: name, status: userStatus }, { passwordHash: hash, algorithm });
    auth.addMembership(user.id, { schoolId, schoolName: schoolId === SCHOOL_A ? "Alpha" : "Bravo", schoolStatus: "ACTIVE", status, roles });
    return { user, membershipId: auth.memberships.get(user.id)![0]!.membershipId };
  };

  const year = repo.seedYear(SCHOOL_A, "2026/2027", "ACTIVE");
  const nextYear = repo.seedYear(SCHOOL_A, "2027/2028", "PLANNED");
  const oldYear = repo.seedYear(SCHOOL_A, "2025/2026", "CLOSED");
  const p4 = repo.seedClass(SCHOOL_A, "Primary 4");
  const p5 = repo.seedClass(SCHOOL_A, "Primary 5");
  const retired = repo.seedClass(SCHOOL_A, "Retired Class", false);
  const foreignClass = repo.seedClass(SCHOOL_B, "Primary 4");
  const foreignYear = repo.seedYear(SCHOOL_B, "2026/2027", "ACTIVE");

  const ama = person("Ama Teacher", SCHOOL_A, ["TEACHER"]);
  const kofi = person("Kofi Teacher", SCHOOL_A, ["TEACHER"]);
  const suspended = person("Suspended Teacher", SCHOOL_A, ["TEACHER"], "SUSPENDED");
  const ended = person("Ended Teacher", SCHOOL_A, ["TEACHER"], "ENDED");
  const invited = person("Invited Teacher", SCHOOL_A, ["TEACHER"], "INVITED");
  const disabled = person("Disabled Teacher", SCHOOL_A, ["TEACHER"], "ACTIVE", "DISABLED");
  const bursar = person("Bursar Person", SCHOOL_A, ["BURSAR"]);
  const head = person("Head Person", SCHOOL_A, ["HEADTEACHER"]);
  const foreignTeacher = person("Foreign Teacher", SCHOOL_B, ["TEACHER"]);

  return { auth, repo, service, year, nextYear, oldYear, p4, p5, retired, foreignClass, foreignYear, ama, kofi, suspended, ended, invited, disabled, bursar, head, foreignTeacher };
}

export const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; value: T }).value; };
export const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : r.error);
export const fieldsOf = (r: { ok: boolean; fields?: Record<string, string> }) => (r.ok ? {} : r.fields ?? {});
