import * as crypto from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing.
 *
 *  - Argon2id (Node's built-in implementation, Node >= 24.7) when available.
 *    No native package is installed, so there is nothing to compile on Windows.
 *  - Node's built-in scrypt otherwise (the approved fallback).
 *
 * Output formats match the database CHECK constraints:
 *   argon2id:  $argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<hash>   (PHC format)
 *   scrypt:    scrypt$<N>$<r>$<p>$<salt>$<hash>
 * Salt and hash are base64 without padding. Parameters are stored inside each
 * hash, so they can be raised later and old hashes still verify (needsRehash).
 */

type Argon2Params = {
  message: Buffer;
  nonce: Buffer;
  parallelism: number;
  tagLength: number;
  memory: number;
  passes: number;
};
type Argon2Fn = (
  algorithm: "argon2id",
  params: Argon2Params,
  callback: (error: Error | null, derived: Buffer) => void,
) => void;

// Feature-detected, not imported by name, so this compiles with any @types/node.
const nativeArgon2 = (crypto as unknown as { argon2?: Argon2Fn }).argon2;
const argon2Async = nativeArgon2 ? promisify(nativeArgon2) : undefined;

const scryptAsync = promisify(crypto.scrypt) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

export const ARGON2_PARAMS = { memoryKiB: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;
export const SCRYPT_PARAMS = { N: 131_072, r: 8, p: 1, keyLength: 32 } as const;

// Upper bounds on parameters read back from the database, so a tampered row
// cannot make the server allocate gigabytes.
const MAX = { argon2MemoryKiB: 262_144, argon2Passes: 10, argon2Parallelism: 4, scryptN: 1 << 20, scryptR: 16, scryptP: 4 };

export type Algorithm = "argon2id" | "scrypt";

export function preferredAlgorithm(): Algorithm {
  return argon2Async ? "argon2id" : "scrypt";
}

export interface HashOptions {
  /** Only for tests: use cheaper parameters. */
  fast?: boolean;
  /** Only for tests: force an algorithm. */
  algorithm?: Algorithm;
}

const b64 = (buffer: Buffer) => buffer.toString("base64").replace(/=+$/, "");
const fromB64 = (value: string) => Buffer.from(value, "base64");

/** Passwords are Unicode-normalised so the same text always hashes the same. */
function prepare(password: string): Buffer {
  return Buffer.from(password.normalize("NFKC"), "utf8");
}

export async function hashPassword(
  password: string,
  options: HashOptions = {},
): Promise<{ hash: string; algorithm: Algorithm }> {
  const algorithm = options.algorithm ?? preferredAlgorithm();
  const salt = crypto.randomBytes(16);
  if (algorithm === "argon2id") {
    if (!argon2Async) throw new Error("Argon2id is not available in this Node.js version.");
    const memory = options.fast ? 64 : ARGON2_PARAMS.memoryKiB;
    const passes = options.fast ? 1 : ARGON2_PARAMS.passes;
    const derived = await argon2Async("argon2id", {
      message: prepare(password),
      nonce: salt,
      parallelism: ARGON2_PARAMS.parallelism,
      tagLength: ARGON2_PARAMS.tagLength,
      memory,
      passes,
    });
    return {
      algorithm,
      hash: `$argon2id$v=19$m=${memory},t=${passes},p=${ARGON2_PARAMS.parallelism}$${b64(salt)}$${b64(derived)}`,
    };
  }
  const N = options.fast ? 1024 : SCRYPT_PARAMS.N;
  const derived = await scryptAsync(prepare(password), salt, SCRYPT_PARAMS.keyLength, {
    N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 256 * 1024 * 1024,
  });
  return { algorithm, hash: `scrypt$${N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${b64(salt)}$${b64(derived)}` };
}

const ARGON2_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const SCRYPT_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export interface VerifyResult {
  ok: boolean;
  /** True when the password is right but the stored hash uses weaker or older parameters. */
  needsRehash: boolean;
}

/** Never throws: a malformed or unsupported stored hash simply fails to verify. */
export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const fail: VerifyResult = { ok: false, needsRehash: false };
  try {
    const argon = ARGON2_RE.exec(stored);
    if (argon) {
      if (!argon2Async) return fail; // cannot verify here (database moved to an older Node)
      const memory = Number(argon[1]);
      const passes = Number(argon[2]);
      const parallelism = Number(argon[3]);
      if (memory > MAX.argon2MemoryKiB || passes > MAX.argon2Passes || parallelism > MAX.argon2Parallelism) return fail;
      const expected = fromB64(argon[5]!);
      const derived = await argon2Async("argon2id", {
        message: prepare(password),
        nonce: fromB64(argon[4]!),
        parallelism,
        tagLength: expected.length,
        memory,
        passes,
      });
      const ok = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
      const weaker = memory < ARGON2_PARAMS.memoryKiB || passes < ARGON2_PARAMS.passes;
      return { ok, needsRehash: ok && weaker };
    }
    const scrypt = SCRYPT_RE.exec(stored);
    if (scrypt) {
      const N = Number(scrypt[1]);
      const r = Number(scrypt[2]);
      const p = Number(scrypt[3]);
      if (N > MAX.scryptN || r > MAX.scryptR || p > MAX.scryptP || (N & (N - 1)) !== 0) return fail;
      const expected = fromB64(scrypt[5]!);
      const derived = await scryptAsync(prepare(password), fromB64(scrypt[4]!), expected.length, {
        N,
        r,
        p,
        maxmem: 256 * 1024 * 1024,
      });
      const ok = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
      // A scrypt hash should move to Argon2id as soon as Argon2id is available.
      const weaker = N < SCRYPT_PARAMS.N || Boolean(argon2Async);
      return { ok, needsRehash: ok && weaker };
    }
    return fail;
  } catch {
    return fail;
  }
}

/**
 * A valid hash of a random password, used to spend the same time on a login for
 * an unknown email as on a real one, so response time does not reveal whether
 * an account exists.
 */
let dummyHash: Promise<string> | undefined;
export function verifyAgainstDummy(password: string): Promise<VerifyResult> {
  dummyHash ??= hashPassword(crypto.randomBytes(24).toString("base64url")).then((r) => r.hash);
  return dummyHash.then((hash) => verifyPassword(password, hash));
}

// ---------------------------------------------------------------------------
// Password policy (NIST SP 800-63B style: length over composition rules)
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const COMMON = new Set(
  [
    "password1234", "password12345", "123456789012", "qwertyuiop12", "letmein12345",
    "welcome12345", "admin1234567", "iloveyou1234", "changeme1234", "schooladmin1",
  ].map((v) => v.toLowerCase()),
);

export type PasswordProblem = "too_short" | "too_long" | "too_common" | "contains_email" | "all_same_character";

export function checkPasswordPolicy(password: string, context: { email?: string } = {}): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const length = [...password.normalize("NFKC")].length;
  if (length < PASSWORD_MIN_LENGTH) problems.push("too_short");
  if (length > PASSWORD_MAX_LENGTH) problems.push("too_long");
  if (COMMON.has(password.toLowerCase())) problems.push("too_common");
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) problems.push("contains_email");
  if (length > 0 && new Set([...password]).size === 1) problems.push("all_same_character");
  return problems;
}
