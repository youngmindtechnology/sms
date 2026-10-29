import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import { noStore, requireAuth, requirePermission, requireSchool } from "../http/middleware.js";
import type { EnrollmentService } from "../students/enrollmentService.js";
import type { GuardianService } from "../students/guardianService.js";
import type { StudentService } from "../students/studentService.js";
import { actorOf, badRequest, id, send } from "./studentHttp.js";

// Shape only; the real rules (lengths, formats, dates) live in the services.
const text = z.string().max(300);
const optionalText = z.string().max(300).nullable().optional();
const studentBody = z.object({
  admissionNumber: optionalText, firstName: text, middleName: optionalText, lastName: text, dateOfBirth: optionalText, admittedOn: optionalText,
}).strict();
const studentPatch = z.object({
  admissionNumber: text.optional(), firstName: text.optional(), middleName: optionalText, lastName: text.optional(), dateOfBirth: optionalText, admittedOn: optionalText,
}).strict();
const statusBody = z.object({ status: z.string().max(30), effectiveDate: z.string().max(20).optional() }).strict();
const listQuery = z.object({
  search: z.string().max(200).optional(),
  status: z.string().max(30).optional(),
  classId: id.optional(),
  page: z.string().regex(/^\d{1,5}$/).optional(),
  pageSize: z.string().regex(/^\d{1,4}$/).optional(),
}).strict();
const guardianDetails = z.object({ fullName: text, phone: optionalText, email: optionalText }).strict();
const linkBody = z.object({
  guardianId: z.string().max(64).optional(), guardian: guardianDetails.optional(), relationship: z.string().max(30), isPrimaryContact: z.boolean().optional(),
}).strict();
const linkPatch = z.object({ relationship: z.string().max(30).optional(), isPrimaryContact: z.boolean().optional() }).strict();
const enrollBody = z.object({ classId: z.string().max(64), academicYearId: z.string().max(64), startDate: z.string().max(20).optional() }).strict();
const transferBody = z.object({ classId: z.string().max(64), effectiveDate: z.string().max(20).optional() }).strict();

/**
 * Students for the signed-in user's ACTIVE school (taken from the session, never the request).
 * Reading needs students:read; every change needs students:write. There is deliberately no DELETE
 * route for students or enrollments: history is kept. The only DELETE removes a guardian LINK.
 */
export function createStudentRouter(auth: AuthService, students: StudentService, guardians: GuardianService, enrollments: EnrollmentService, config: AppConfig): Router {
  const router = Router();
  const read = [requireAuth(auth, config), requireSchool, requirePermission("students:read")];
  const write = [requireAuth(auth, config), requireSchool, requirePermission("students:write")];

  router.use(noStore);

  router.get("/", ...read, async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) return badRequest(res);
    const { page, pageSize, ...rest } = query.data;
    return send(res, await students.list(actorOf(res), { ...rest, page: page === undefined ? undefined : Number(page), pageSize: pageSize === undefined ? undefined : Number(pageSize) }));
  });

  router.post("/", ...write, async (req, res) => {
    const body = studentBody.safeParse(req.body);
    if (!body.success) return badRequest(res);
    return send(res, await students.register(actorOf(res), body.data), 201);
  });

  router.get("/:studentId", ...read, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    if (!studentId.success) return badRequest(res);
    return send(res, await students.profile(actorOf(res), studentId.data));
  });

  router.patch("/:studentId", ...write, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    const body = studentPatch.safeParse(req.body);
    if (!studentId.success || !body.success) return badRequest(res);
    return send(res, await students.update(actorOf(res), studentId.data, body.data));
  });

  router.post("/:studentId/status", ...write, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    const body = statusBody.safeParse(req.body);
    if (!studentId.success || !body.success) return badRequest(res);
    return send(res, await students.changeStatus(actorOf(res), studentId.data, body.data));
  });

  // ----- guardian links of one student -----
  router.post("/:studentId/guardians", ...write, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    const body = linkBody.safeParse(req.body);
    if (!studentId.success || !body.success) return badRequest(res);
    return send(res, await guardians.link(actorOf(res), studentId.data, body.data), 201);
  });

  router.patch("/:studentId/guardians/:guardianId", ...write, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    const guardianId = id.safeParse(req.params.guardianId);
    const body = linkPatch.safeParse(req.body);
    if (!studentId.success || !guardianId.success || !body.success) return badRequest(res);
    return send(res, await guardians.updateLink(actorOf(res), studentId.data, guardianId.data, body.data));
  });

  router.delete("/:studentId/guardians/:guardianId", ...write, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    const guardianId = id.safeParse(req.params.guardianId);
    if (!studentId.success || !guardianId.success) return badRequest(res);
    return send(res, await guardians.unlink(actorOf(res), studentId.data, guardianId.data));
  });

  // ----- enrollments of one student -----
  router.get("/:studentId/enrollments", ...read, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    if (!studentId.success) return badRequest(res);
    return send(res, await enrollments.list(actorOf(res), studentId.data), 200, (enrollmentList) => ({ enrollments: enrollmentList }));
  });

  router.post("/:studentId/enrollments", ...write, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    const body = enrollBody.safeParse(req.body);
    if (!studentId.success || !body.success) return badRequest(res);
    return send(res, await enrollments.enroll(actorOf(res), studentId.data, body.data), 201);
  });

  router.post("/:studentId/enrollments/transfer", ...write, async (req, res) => {
    const studentId = id.safeParse(req.params.studentId);
    const body = transferBody.safeParse(req.body);
    if (!studentId.success || !body.success) return badRequest(res);
    return send(res, await enrollments.transfer(actorOf(res), studentId.data, body.data), 201);
  });

  return router;
}
