const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const isUnsafeMethod = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

/**
 * State-changing requests must come from the configured frontend origin. Browsers
 * always attach Origin to cross-origin and to same-origin POST/PUT/PATCH/DELETE
 * requests, so a missing or different Origin is refused.
 */
export function isTrustedOrigin(originHeader: string | undefined, allowedOrigin: string): boolean {
  return originHeader !== undefined && originHeader === allowedOrigin;
}

/** Minimal Cookie header parser (name=value; name=value). Later duplicates are ignored. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw.replace(/^"(.*)"$/, "$1"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}
