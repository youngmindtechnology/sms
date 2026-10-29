import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import { getAuth, noStore, requireAuth, requirePermission, requireSchool } from "../http/middleware.js";
import type { StaffActor, StaffErrorCode, StaffService, Result } from "../staff/staffService.js";
import type { Response } from "express";

// Shape only; the real rules live in the service.
const membershipId = z.string().uuid();
const createBody = z.object({ email: z.string().max(300), fullName: z.string().max(300), roles: z.array(z.string().max(30)).max(10) }).strict();
const rolesBody = z.object({ roles: z.array(z.string().max(30)).max(10) }).strict();
const statusBody = z.object({ status: z.string().max(30) }).strict();

const STATUS: Record<StaffErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  role_not_allowed: 403,
  cannot_change_own_access: 403,
  email_in_use: 409,
  last_owner: 409,
  membership_ended: 409,
  membership_not_active: 409,
  invalid_status_change: 409,
  shared_account: 409,
};

function send<T>(res: Response, result: Result<T>, success = 200) {
  if (result.ok) return void res.status(success).json(result.value);
  const body: { error: StaffErrorCode; fields?: Record<string, string> } = { error: result.error };
  if (result.fields) body.fields = result.fields;
  return void res.status(STATUS[result.error]).json(body);
}
const badRequest = (res: Response) => void res.status(400).json({ error: "invalid_request" });

/** The school, user and roles come from the verified session, never from the request. */
function actorOf(res: Response): StaffActor {
  const context = getAuth(res)!;
  return { schoolId: context.school!.id, userId: context.user.id, roles: context.school!.roles };
}

/**
 * Staff of the signed-in user's ACTIVE school. Every route needs staff:manage (Owner and
 * Administrator); the service then limits WHICH roles the caller may touch. There is no DELETE:
 * a person who leaves gets the status ENDED and their history stays. Responses that carry a
 * temporary password are never cached and show it only once.
 */
export function createStaffRouter(auth: AuthService, staff: StaffService, config: AppConfig): Router {
  const router = Router();
  const manage = [requireAuth(auth, config), requireSchool, requirePermission("staff:manage")];

  router.use(noStore);

  router.get("/", ...manage, async (_req, res) => send(res, await staff.list(actorOf(res))));

  router.post("/", ...manage, async (req, res) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) return badRequest(res);
    return send(res, await staff.create(actorOf(res), body.data), 201);
  });

  router.patch("/:membershipId/roles", ...manage, async (req, res) => {
    const id = membershipId.safeParse(req.params.membershipId);
    const body = rolesBody.safeParse(req.body);
    if (!id.success || !body.success) return badRequest(res);
    return send(res, await staff.updateRoles(actorOf(res), id.data, body.data));
  });

  router.post("/:membershipId/status", ...manage, async (req, res) => {
    const id = membershipId.safeParse(req.params.membershipId);
    const body = statusBody.safeParse(req.body);
    if (!id.success || !body.success) return badRequest(res);
    return send(res, await staff.changeStatus(actorOf(res), id.data, body.data));
  });

  router.post("/:membershipId/reset-password", ...manage, async (req, res) => {
    const id = membershipId.safeParse(req.params.membershipId);
    if (!id.success) return badRequest(res);
    return send(res, await staff.resetPassword(actorOf(res), id.data));
  });

  return router;
}
