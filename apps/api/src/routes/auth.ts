import { Router } from "express";
import { z } from "zod";
import type { AuthService } from "../auth/authService.js";
import type { AppConfig } from "../config.js";
import {
  clearSessionCookie, forbidden, getAuth, getSessionToken, noStore, rateLimit, requireAuth, requireTrustedOrigin,
  setSessionCookie,
} from "../http/middleware.js";
import { RateLimiter } from "../http/rateLimiter.js";

export interface AuthRouteOptions {
  loginLimiter?: RateLimiter;
  passwordLimiter?: RateLimiter;
}

// Hard length caps stop huge inputs from reaching the (deliberately slow) password hash.
const loginBody = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(1024) }).strict();
const switchBody = z.object({ schoolId: z.string().uuid() }).strict();
const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) }).strict();

const invalidRequest = { error: "invalid_request" };

export function createAuthRouter(auth: AuthService, config: AppConfig, options: AuthRouteOptions = {}): Router {
  const router = Router();
  const loginLimiter = options.loginLimiter ?? new RateLimiter({ windowMs: 15 * 60_000, limit: 20 });
  const passwordLimiter = options.passwordLimiter ?? new RateLimiter({ windowMs: 15 * 60_000, limit: 10 });
  const authenticated = requireAuth(auth, config);

  router.use(noStore);

  router.post("/login", requireTrustedOrigin(config), rateLimit(loginLimiter), async (req, res) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json(invalidRequest);

    const result = await auth.login(body.data.email, body.data.password);
    if (!result.ok) {
      // One answer for every cause: unknown email, wrong password, locked, disabled.
      return void res.status(401).json({ error: "invalid_credentials", message: "Email or password is incorrect." });
    }
    setSessionCookie(res, config, result.sessionToken, result.expiresAt);
    // The session token travels only in the HttpOnly cookie, never in the body.
    return void res.status(200).json({
      user: result.user,
      schools: result.schools,
      activeSchoolId: result.activeSchoolId,
      csrfToken: result.csrfToken,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  router.get("/me", authenticated, (req, res) => {
    const context = getAuth(res)!;
    const token = getSessionToken(res)!;
    return void res.status(200).json({
      user: context.user,
      school: context.school
        ? { id: context.school.id, name: context.school.name, roles: context.school.roles, permissions: [...context.school.permissions].sort() }
        : null,
      schools: context.schools,
      csrfToken: auth.csrfTokenFor(token),
    });
  });

  router.post("/logout", authenticated, async (_req, res) => {
    await auth.logout(getAuth(res)!);
    clearSessionCookie(res, config);
    return void res.status(204).end();
  });

  router.post("/switch-school", authenticated, async (req, res) => {
    const body = switchBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json(invalidRequest);
    const result = await auth.switchSchool(getAuth(res)!, body.data.schoolId);
    // Same answer whether the school does not exist or the user simply is not a member.
    if (!result.ok) return void forbidden(res);
    return void res.status(200).json({ activeSchoolId: body.data.schoolId });
  });

  router.post("/change-password", authenticated, rateLimit(passwordLimiter), async (req, res) => {
    const body = changePasswordBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json(invalidRequest);
    const result = await auth.changePassword(getAuth(res)!, body.data.currentPassword, body.data.newPassword);
    if (!result.ok) {
      // 400, not 401: the person is still signed in and the page must not treat this as a logout.
      return void res.status(400).json({ error: result.reason, problems: result.problems ?? [] });
    }
    return void res.status(204).end();
  });

  return router;
}
