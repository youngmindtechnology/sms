import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import type { AcademicService, ErrorCode, Result } from "../academic/academicService.js";
import type { AppConfig } from "../config.js";
import { getAuth, noStore, requireAuth, requirePermission, requireSchool } from "../http/middleware.js";

const id = z.string().uuid();
// Shape only; real validation (valid calendar dates, ranges, rules) lives in the service.
const yearCreate = z.object({ name: z.string().max(100), startDate: z.string().max(10), endDate: z.string().max(10) }).strict();
const yearPatch = z.object({ name: z.string().max(100).optional(), startDate: z.string().max(10).optional(), endDate: z.string().max(10).optional() }).strict();
const termCreate = z.object({ name: z.string().max(100), sequence: z.number().optional(), startDate: z.string().max(10), endDate: z.string().max(10) }).strict();
const termPatch = z.object({ name: z.string().max(100).optional(), sequence: z.number().optional(), startDate: z.string().max(10).optional(), endDate: z.string().max(10).optional() }).strict();

const STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  duplicate_name: 409,
  duplicate_sequence: 409,
  dates_overlap: 409,
  terms_outside_year: 409,
  outside_year: 409,
  period_closed: 409,
  already_active: 409,
  not_active: 409,
  year_not_active: 409,
  conflict: 409,
};

function send<T>(res: Response, result: Result<T>, success = 200) {
  if (result.ok) return void res.status(success).json(result.value);
  const body: { error: ErrorCode; fields?: Record<string, string> } = { error: result.error };
  if (result.fields) body.fields = result.fields;
  return void res.status(STATUS[result.error]).json(body);
}

const badRequest = (res: Response) => void res.status(400).json({ error: "invalid_request" });

/**
 * Academic years and terms for the signed-in user's ACTIVE school. The school id comes from
 * the verified session (getAuth), never from the URL or body. Reads need academics:read;
 * every change needs calendar:manage.
 */
export function createAcademicRouter(auth: AuthService, service: AcademicService, config: AppConfig): Router {
  const router = Router();
  const read = [requireAuth(auth, config), requireSchool, requirePermission("academics:read")];
  const manage = [requireAuth(auth, config), requireSchool, requirePermission("calendar:manage")];
  const actor = (res: Response) => {
    const context = getAuth(res)!;
    return { schoolId: context.school!.id, userId: context.user.id };
  };

  router.use(noStore);

  router.get("/", ...read, async (_req, res) => void res.status(200).json({ years: await service.listYears(actor(res)) }));

  router.post("/", ...manage, async (req, res) => {
    const body = yearCreate.safeParse(req.body);
    if (!body.success) return badRequest(res);
    return send(res, await service.createYear(actor(res), body.data), 201);
  });

  router.get("/:yearId", ...read, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    if (!yearId.success) return badRequest(res);
    return send(res, await service.getYear(actor(res), yearId.data));
  });

  router.patch("/:yearId", ...manage, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    const body = yearPatch.safeParse(req.body);
    if (!yearId.success || !body.success) return badRequest(res);
    return send(res, await service.updateYear(actor(res), yearId.data, body.data));
  });

  router.post("/:yearId/activate", ...manage, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    if (!yearId.success) return badRequest(res);
    return send(res, await service.activateYear(actor(res), yearId.data));
  });

  router.post("/:yearId/close", ...manage, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    if (!yearId.success) return badRequest(res);
    return send(res, await service.closeYear(actor(res), yearId.data));
  });

  router.get("/:yearId/terms", ...read, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    if (!yearId.success) return badRequest(res);
    const result = await service.listTerms(actor(res), yearId.data);
    return result.ok ? void res.status(200).json({ terms: result.value }) : send(res, result);
  });

  router.post("/:yearId/terms", ...manage, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    const body = termCreate.safeParse(req.body);
    if (!yearId.success || !body.success) return badRequest(res);
    return send(res, await service.createTerm(actor(res), yearId.data, body.data), 201);
  });

  router.patch("/:yearId/terms/:termId", ...manage, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    const termId = id.safeParse(req.params.termId);
    const body = termPatch.safeParse(req.body);
    if (!yearId.success || !termId.success || !body.success) return badRequest(res);
    return send(res, await service.updateTerm(actor(res), yearId.data, termId.data, body.data));
  });

  router.post("/:yearId/terms/:termId/activate", ...manage, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    const termId = id.safeParse(req.params.termId);
    if (!yearId.success || !termId.success) return badRequest(res);
    return send(res, await service.activateTerm(actor(res), yearId.data, termId.data));
  });

  router.post("/:yearId/terms/:termId/close", ...manage, async (req, res) => {
    const yearId = id.safeParse(req.params.yearId);
    const termId = id.safeParse(req.params.termId);
    if (!yearId.success || !termId.success) return badRequest(res);
    return send(res, await service.closeTerm(actor(res), yearId.data, termId.data));
  });

  return router;
}
