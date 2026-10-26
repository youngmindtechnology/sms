import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import type { ClassErrorCode, ClassService, Result } from "../classes/classService.js";
import type { AppConfig } from "../config.js";
import { getAuth, noStore, requireAuth, requirePermission, requireSchool } from "../http/middleware.js";

const id = z.string().uuid();
// Shape only; real validation (name rules, levels, ranges) lives in the service.
const createBody = z.object({ name: z.string().max(200), level: z.string().max(30), sortOrder: z.number().optional() }).strict();
const patchBody = z.object({ name: z.string().max(200).optional(), level: z.string().max(30).optional(), sortOrder: z.number().optional(), isActive: z.boolean().optional() }).strict();
const orderBody = z.object({ classIds: z.array(z.string().max(64)).max(500) }).strict();

const STATUS: Record<ClassErrorCode, number> = { validation_error: 400, not_found: 404, duplicate_name: 409, order_mismatch: 409 };

function send<T>(res: Response, result: Result<T>, success = 200) {
  if (result.ok) return void res.status(success).json(result.value);
  const body: { error: ClassErrorCode; fields?: Record<string, string> } = { error: result.error };
  if (result.fields) body.fields = result.fields;
  return void res.status(STATUS[result.error]).json(body);
}
const badRequest = (res: Response) => void res.status(400).json({ error: "invalid_request" });

/**
 * Classes for the signed-in user's ACTIVE school (taken from the session, never the request).
 * Reading needs school:read (every role); every change needs classes:manage.
 * There is deliberately no DELETE route: classes are history for enrollments.
 */
export function createClassRouter(auth: AuthService, service: ClassService, config: AppConfig): Router {
  const router = Router();
  const read = [requireAuth(auth, config), requireSchool, requirePermission("school:read")];
  const manage = [requireAuth(auth, config), requireSchool, requirePermission("classes:manage")];
  const actor = (res: Response) => {
    const context = getAuth(res)!;
    return { schoolId: context.school!.id, userId: context.user.id };
  };

  router.use(noStore);

  router.get("/", ...read, async (_req, res) => void res.status(200).json({ classes: await service.listClasses(actor(res)) }));

  router.post("/", ...manage, async (req, res) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return badRequest(res);
    return send(res, await service.createClass(actor(res), body.data), 201);
  });

  router.put("/order", ...manage, async (req, res) => {
    const body = orderBody.safeParse(req.body);
    if (!body.success) return badRequest(res);
    const result = await service.reorderClasses(actor(res), body.data.classIds);
    return result.ok ? void res.status(200).json({ classes: result.value }) : send(res, result);
  });

  router.patch("/:classId", ...manage, async (req, res) => {
    const classId = id.safeParse(req.params.classId);
    const body = patchBody.safeParse(req.body);
    if (!classId.success || !body.success) return badRequest(res);
    return send(res, await service.updateClass(actor(res), classId.data, body.data));
  });

  return router;
}
