import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import { noStore, requireAuth, requirePermission, requireSchool } from "../http/middleware.js";
import type { EnrollmentService } from "../students/enrollmentService.js";
import { actorOf, badRequest, id, send } from "./studentHttp.js";

const rosterQuery = z.object({ classId: id, academicYearId: id, includeEnded: z.enum(["true", "false"]).optional() }).strict();

/** Class rosters for the active school. Enrolling and class changes live under /api/students/:id/enrollments. */
export function createEnrollmentRouter(auth: AuthService, enrollments: EnrollmentService, config: AppConfig): Router {
  const router = Router();
  const read = [requireAuth(auth, config), requireSchool, requirePermission("students:read")];

  router.use(noStore);

  router.get("/roster", ...read, async (req, res) => {
    const query = rosterQuery.safeParse(req.query);
    if (!query.success) return badRequest(res);
    return send(res, await enrollments.roster(actorOf(res), query.data.classId, query.data.academicYearId, query.data.includeEnded === "true"));
  });

  return router;
}
