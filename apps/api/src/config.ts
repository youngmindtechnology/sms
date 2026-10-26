import { z } from "zod";

/**
 * Environment validation. The API refuses to start with a missing or unsafe
 * setting, and error messages name the variable but never print its value
 * (DATABASE_URL contains a password).
 */
const origin = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  }, "must be an origin such as http://localhost:5173 (no path, no trailing slash)");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FRONTEND_ORIGIN: origin.default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1, "is required"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(120),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
  // Number of reverse proxies in front of the API (0 = none). Needed so the rate
  // limiter sees the real client address instead of the proxy.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});

export interface AppConfig {
  env: "development" | "test" | "production";
  port: number;
  frontendOrigin: string;
  isProduction: boolean;
  trustProxyHops: number;
  session: {
    cookieName: string;
    /** Absolute lifetime of a session. */
    ttlMs: number;
    /** A session unused for this long is rejected. */
    idleMs: number;
    /** Cookies are only sent over HTTPS in production. */
    secureCookie: boolean;
  };
  login: {
    maxFailures: number;
    lockoutMs: number;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Parses and validates the environment. Never includes values in errors. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(env)"}: ${issue.message}`),
    );
  }
  const values = parsed.data;
  const problems: string[] = [];

  if (!/^postgres(ql)?:\/\//.test(values.DATABASE_URL)) {
    problems.push("DATABASE_URL: must start with postgresql://");
  }
  const isProduction = values.NODE_ENV === "production";
  if (isProduction && !values.FRONTEND_ORIGIN.startsWith("https://")) {
    problems.push("FRONTEND_ORIGIN: must use https:// in production");
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: values.NODE_ENV,
    port: values.PORT,
    frontendOrigin: values.FRONTEND_ORIGIN,
    isProduction,
    trustProxyHops: values.TRUST_PROXY_HOPS,
    session: {
      // The __Host- prefix makes browsers refuse the cookie unless it is Secure,
      // has Path=/ and carries no Domain attribute, so it cannot be set from a subdomain.
      cookieName: isProduction ? "__Host-ymt_session" : "ymt_session",
      ttlMs: values.SESSION_TTL_HOURS * 3_600_000,
      idleMs: values.SESSION_IDLE_MINUTES * 60_000,
      secureCookie: isProduction,
    },
    login: {
      maxFailures: values.LOGIN_MAX_FAILURES,
      lockoutMs: values.LOGIN_LOCKOUT_MINUTES * 60_000,
    },
  };
}
