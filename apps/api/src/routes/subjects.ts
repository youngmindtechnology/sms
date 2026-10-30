import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import { getAuth, noStore, requireAuth, requirePermission, requireSchool } from "../http/middleware.js";
import type { Result, SubjectErrorCode, SubjectService } from "../subjects/subjectService.js";

const id = z.string().uuid();
// Shape only; the real rules (name length, code format, ids that belong to the school) live in the service.
const createBody = z.object({ classId: z.string().max(64), name: z.string().max(200), code: z.string().max(100).nullable().optional() }).strict();
const patchBody = z.object({ name: z.string().max(200).optional(), code: z.string().max(100).nullable().optional(), isActive: z.boolean().optional() }).strict();
const listQuery = z.object({ classId: id, academicYearId: id.optional() }).strict();
const assignmentsQuery = z.object({ academicYearId: id.optional(), includeEnded: z.enum(["true", "false"]).optional() }).strict();
const assignBody = z.object({ academicYearId: z.string().max(64), teacherMembershipId: z.string().max(64) }).strict();
const replaceBody = z.object({ teacherMembershipId: z.string().max(64) }).strict();
const noBody = z.object({}).strict();

const STATUS: Record<SubjectErrorCode, number> = {
  validation_error: 400, not_found: 404,
  duplicate_name: 409, duplicate_code: 409, class_inactive: 409, subject_inactive: 409, year_closed: 409,
  teacher_not_eligible: 409, already_assigned: 409, assignment_ended: 409,
};

function send<T>(res: Response, result: Result<T>, success = 200) {
  if (result.ok) return void res.status(success).json(result.value);
  const body: { error: SubjectErrorCode; fields?: Record<string, string> } = { error: result.error };
  if (result.fields) body.fields = result.fields;
  return void res.status(STATUS[result.error]).json(body);
}
const badRequest = (res: Response) => void res.status(400).json({ error: "invalid_request" });

/**
 * Subjects for the signed-in user's ACTIVE school (taken from the session, never from the request).
 * Reading needs academics:read (Owner, Headteacher, Administrator, Teacher). Creating and editing subjects
 * needs subjects:manage; assigning teachers needs subjects:assign. There is deliberately no DELETE route.
 */
export function createSubjectRouter(auth: AuthService, service: SubjectService, config: AppConfig): Router {
  const router = Router();
  const read = [requireAuth(auth, config), requireSchool, requirePermission("academics:read")];
  const manage = [requireAuth(auth, config), requireSchool, requirePermission("subjects:manage")];
  const assignPermission = [requireAuth(auth, config), requireSchool, requirePermission("subjects:assign")];
  const actor = (res: Response) => {
    const context = getAuth(res)!;
    return { schoolId: context.school!.id, userId: context.user.id };
  };

  router.use(noStore);

  router.get("/", ...read, async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) return badRequest(res);
    return send(res, await service.listForClass(actor(res), query.data.classId, query.data.academicYearId));
  });

  router.post("/", ...manage, async (req, res) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return badRequest(res);
    return send(res, await service.createSubject(actor(res), body.data), 201);
  });

  router.patch("/:subjectId", ...manage, async (req, res) => {
    const subjectId = id.safeParse(req.params.subjectId);
    const body = patchBody.safeParse(req.body);
    if (!subjectId.success || !body.success) return badRequest(res);
    return send(res, await service.updateSubject(actor(res), subjectId.data, body.data));
  });

  router.get("/:subjectId/assignments", ...read, async (req, res) => {
    const subjectId = id.safeParse(req.params.subjectId);
    const query = assignmentsQuery.safeParse(req.query);
    if (!subjectId.success || !query.success) return badRequest(res);
    const result = await service.listAssignments(actor(res), subjectId.data, { academicYearId: query.data.academicYearId, includeEnded: query.data.includeEnded === "true" });
    return result.ok ? void res.status(200).json({ assignments: result.value }) : send(res, result);
  });

  router.post("/:subjectId/assignments", ...assignPermission, async (req, res) => {
    const subjectId = id.safeParse(req.params.subjectId);
    const body = assignBody.safeParse(req.body);
    if (!subjectId.success || !body.success) return badRequest(res);
    return send(res, await service.assign(actor(res), subjectId.data, body.data), 201);
  });

  return router;
}

/** Changes to one assignment (replace the teacher, end it) and the list of teachers who may be assigned. */
export function createTeachingAssignmentRouter(auth: AuthService, service: SubjectService, config: AppConfig): Router {
  const router = Router();
  const assignPermission = [requireAuth(auth, config), requireSchool, requirePermission("subjects:assign")];
  const actor = (res: Response) => {
    const context = getAuth(res)!;
    return { schoolId: context.school!.id, userId: context.user.id };
  };

  router.use(noStore);

  router.get("/eligible-teachers", ...assignPermission, async (_req, res) => {
    return void res.status(200).json({ teachers: await service.eligibleTeachers(actor(res)) });
  });

  router.post("/:assignmentId/replace", ...assignPermission, async (req, res) => {
    const assignmentId = id.safeParse(req.params.assignmentId);
    const body = replaceBody.safeParse(req.body);
    if (!assignmentId.success || !body.success) return badRequest(res);
    return send(res, await service.replace(actor(res), assignmentId.data, body.data), 201);
  });

  router.post("/:assignmentId/end", ...assignPermission, async (req, res) => {
    const assignmentId = id.safeParse(req.params.assignmentId);
    const body = noBody.safeParse(req.body ?? {});
    if (!assignmentId.success || !body.success) return badRequest(res);
    return send(res, await service.end(actor(res), assignmentId.data));
  });

  return router;
}
