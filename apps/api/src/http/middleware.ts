import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import type { AppConfig } from "../config.js";
import type { AuthContext, AuthService } from "../auth/authService.js";
import type { Permission } from "../auth/permissions.js";
import { looksLikeToken } from "../auth/tokens.js";
import type { RateLimiter } from "./rateLimiter.js";
import { isTrustedOrigin, isUnsafeMethod, readCookie } from "./requestChecks.js";

export const unauthenticated = (res: Response) => res.status(401).json({ error: "unauthenticated" });
export const forbidden = (res: Response, code = "forbidden") => res.status(403).json({ error: code });

/** The authenticated caller, set by requireAuth. Handlers must use this, never a client-supplied school id. */
export const getAuth = (res: Response): AuthContext | undefined => res.locals.auth as AuthContext | undefined;
export const getSessionToken = (res: Response): string | undefined => res.locals.sessionToken as string | undefined;

export function cookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    secure: config.session.secureCookie,
    sameSite: "strict" as const,
    path: "/",
  };
}

export function setSessionCookie(res: Response, config: AppConfig, token: string, expiresAt: Date): void {
  res.cookie(config.session.cookieName, token, { ...cookieOptions(config), expires: expiresAt });
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.clearCookie(config.session.cookieName, cookieOptions(config));
}

/** Refuses state-changing requests that do not come from the frontend origin. */
export function requireTrustedOrigin(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    if (isUnsafeMethod(req.method) && !isTrustedOrigin(req.get("origin"), config.frontendOrigin)) {
      return void forbidden(res, "bad_origin");
    }
    next();
  };
}

/** Authentication responses must never be cached by browsers or proxies. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

export function rateLimit(limiter: RateLimiter, keyOf: (req: Request) => string = (req) => req.ip ?? "unknown"): RequestHandler {
  return (req, res, next) => {
    const decision = limiter.check(keyOf(req));
    if (!decision.allowed) {
      res.set("Retry-After", String(decision.retryAfterSeconds));
      return void res.status(429).json({ error: "too_many_requests" });
    }
    next();
  };
}

/**
 * Requires a valid session cookie. For state-changing methods it also requires the
 * trusted Origin and a matching X-CSRF-Token header. 401 = not signed in; 403 = signed
 * in but the request is not allowed.
 */
export function requireAuth(auth: AuthService, config: AppConfig, options: { allowPasswordChangePending?: boolean } = {}): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req.headers.cookie, config.session.cookieName);
    if (!looksLikeToken(token)) return void unauthenticated(res);
    const context = await auth.authenticate(token);
    if (!context) {
      clearSessionCookie(res, config);
      return void unauthenticated(res);
    }
    if (isUnsafeMethod(req.method)) {
      if (!isTrustedOrigin(req.get("origin"), config.frontendOrigin)) return void forbidden(res, "bad_origin");
      if (!(await auth.csrfMatches(token, req.get("x-csrf-token")))) return void forbidden(res, "bad_csrf");
    }
    // A temporary password must be replaced first. Only "who am I", change-password and logout stay open.
    if (context.mustChangePassword && !options.allowPasswordChangePending) return void forbidden(res, "password_change_required");
    res.locals.auth = context;
    res.locals.sessionToken = token;
    next();
  };
}

/** The session must have a valid active school (verified fresh on every request). */
export const requireSchool: RequestHandler = (_req, res, next) => {
  if (!getAuth(res)?.school) return void forbidden(res, "school_required");
  next();
};

export function requirePermission(permission: Permission): RequestHandler {
  return (_req, res, next) => {
    const school = getAuth(res)?.school;
    if (!school) return void forbidden(res, "school_required");
    if (!school.permissions.has(permission)) return void forbidden(res, "insufficient_permission");
    next();
  };
}

/**
 * Last-resort error handler. It answers with a fixed code and logs only the error's
 * class name, because messages from the database or body parser can contain submitted
 * values (passwords included).
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) {
    // Only the class name and a Prisma code like P1000 (matched strictly), never the message.
    const rawCode = (err as { errorCode?: unknown; code?: unknown } | null)?.errorCode ?? (err as { code?: unknown } | null)?.code;
    const code = typeof rawCode === "string" && /^P\d{4}$/.test(rawCode) ? ` (${rawCode})` : "";
    console.error(`Unhandled error: ${err instanceof Error ? err.name : "unknown"}${code}`);
  }
  res.status(status).json({ error: status === 413 ? "payload_too_large" : status < 500 ? "invalid_request" : "internal_error" });
};
