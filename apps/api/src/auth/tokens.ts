import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits from the operating system's CSPRNG, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of a token. Only this hash is stored in the database. */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * The CSRF token is derived from the session token, so it can be handed to the
 * page again after a reload without storing it. Without the session token (an
 * HttpOnly cookie) it cannot be computed.
 */
export function deriveCsrfToken(sessionToken: string): string {
  return createHash("sha256").update(`ymt-csrf:${sessionToken}`, "utf8").digest("base64url");
}

/** Constant-time comparison of two buffers of any length. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Tokens are exactly 43 base64url characters; anything else is rejected early. */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
