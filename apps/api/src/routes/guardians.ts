import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import { noStore, requireAuth, requirePermission, requireSchool } from "../http/middleware.js";
import type { GuardianService } from "../students/guardianService.js";
import { actorOf, badRequest, id, send } from "./studentHttp.js";

const text = z.string().max(300);
const patchBody = z.object({ fullName: text.optional(), phone: text.nullable().optional(), email: text.nullable().optional() }).strict();
const searchQuery = z.object({ search: z.string().max(200) }).strict();

/**
 * Guardians of the signed-in user's ACTIVE school. Guardian records are created and linked through
 * /api/students/:id/guardians. Searching (to link an existing guardian) and editing need
 * students:write; viewing one guardian needs students:read. There is no DELETE: a guardian may
 * belong to several children, and history is kept.
 */
export function createGuardianRouter(auth: AuthService, guardians: GuardianService, config: AppConfig): Router {
  const router = Router();
  const read = [requireAuth(auth, config), requireSchool, requirePermission("students:read")];
  const write = [requireAuth(auth, config), requireSchool, requirePermission("students:write")];

  router.use(noStore);

  router.get("/", ...write, async (req, res) => {
    const query = searchQuery.safeParse(req.query);
    if (!query.success) return badRequest(res);
    return send(res, await guardians.search(actorOf(res), query.data.search), 200, (found) => ({ guardians: found }));
  });

  router.get("/:guardianId", ...read, async (req, res) => {
    const guardianId = id.safeParse(req.params.guardianId);
    if (!guardianId.success) return badRequest(res);
    return send(res, await guardians.detail(actorOf(res), guardianId.data));
  });

  router.patch("/:guardianId", ...write, async (req, res) => {
    const guardianId = id.safeParse(req.params.guardianId);
    const body = patchBody.safeParse(req.body);
    if (!guardianId.success || !body.success) return badRequest(res);
    return send(res, await guardians.update(actorOf(res), guardianId.data, body.data));
  });

  return router;
}
