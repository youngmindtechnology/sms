import type { AuditEventInput, AuthRepository } from "./ports.js";

/**
 * Audit metadata must never carry credentials. Keys that look like secrets are
 * refused outright (a programming error caught in tests), and string values that
 * look like tokens or hashes are refused as well.
 */
const FORBIDDEN_KEY = /pass(word)?|secret|token|hash|cookie|authorization|credential|session[_-]?id/i;
const TOKEN_LIKE = /^[A-Za-z0-9_-]{40,}$|^\$argon2|^scrypt\$/;

export function assertAuditSafe(value: unknown, path = "metadata"): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && TOKEN_LIKE.test(value)) {
      throw new Error(`Audit ${path} looks like a secret and was refused.`);
    }
    return;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`Audit ${path}.${key} is a forbidden key and was refused.`);
    assertAuditSafe(inner, `${path}.${key}`);
  }
}

export async function recordAudit(repo: AuthRepository, event: AuditEventInput): Promise<void> {
  assertAuditSafe(event.metadata);
  await repo.appendAudit(event);
}
