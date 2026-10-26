import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { test } from "node:test";
import {
  ARGON2_PARAMS, checkPasswordPolicy, hashPassword, preferredAlgorithm, verifyPassword,
} from "./password.js";

const hasArgon2 = typeof (crypto as unknown as { argon2?: unknown }).argon2 === "function";

test("scrypt: round trip, wrong password, and the database format check", async () => {
  const { hash, algorithm } = await hashPassword("a long enough passphrase", { algorithm: "scrypt", fast: true });
  assert.equal(algorithm, "scrypt");
  assert.match(hash, /^scrypt\$\d+\$8\$1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  assert.ok(hash.length >= 20 && hash.length <= 512); // user_credentials_hash_format_chk
  assert.equal((await verifyPassword("a long enough passphrase", hash)).ok, true);
  assert.equal((await verifyPassword("a long enough passphrasE", hash)).ok, false);
  assert.equal((await verifyPassword("", hash)).ok, false);
});

test("two hashes of the same password differ (random salt)", async () => {
  const a = await hashPassword("same password, twice", { algorithm: "scrypt", fast: true });
  const b = await hashPassword("same password, twice", { algorithm: "scrypt", fast: true });
  assert.notEqual(a.hash, b.hash);
});

test("hash never contains the password", async () => {
  const pw = "plain-text-marker-9f3c";
  const { hash } = await hashPassword(pw, { algorithm: "scrypt", fast: true });
  assert.ok(!hash.includes(pw));
});

test("malformed, empty and hostile stored hashes fail without throwing", async () => {
  for (const stored of [
    "", "not a hash", "$argon2id$", "scrypt$", "scrypt$1024$8$1$$", "$2b$12$abcdefghijklmnopqrstuv",
    "scrypt$3$8$1$AAAA$AAAA", // N not a power of two
    "scrypt$1073741824$8$1$AAAA$AAAA", // absurd cost: must be refused, not attempted
    "$argon2id$v=19$m=4194304,t=2,p=1$AAAA$AAAA", // 4 GiB memory: refused
    "$argon2id$v=19$m=19456,t=99,p=1$AAAA$AAAA",
  ]) {
    assert.deepEqual(await verifyPassword("anything", stored), { ok: false, needsRehash: false }, stored);
  }
});

test("Unicode-equivalent passwords verify (NFKC normalisation)", async () => {
  const { hash } = await hashPassword("café passphrase!", { algorithm: "scrypt", fast: true });
  assert.equal((await verifyPassword("café passphrase!", hash)).ok, true);
});

test("a cheap scrypt hash is flagged for rehash, a full-cost one is not (when Argon2 is unavailable)", async () => {
  const cheap = await hashPassword("rehash me please!!", { algorithm: "scrypt", fast: true });
  assert.equal((await verifyPassword("rehash me please!!", cheap.hash)).needsRehash, true);
  if (!hasArgon2) {
    const full = await hashPassword("rehash me please!!", { algorithm: "scrypt" });
    assert.equal((await verifyPassword("rehash me please!!", full.hash)).needsRehash, false);
  }
});

test("preferred algorithm is argon2id exactly when the runtime provides it", () => {
  assert.equal(preferredAlgorithm(), hasArgon2 ? "argon2id" : "scrypt");
});

test("Argon2id: round trip, format and rehash flag", { skip: !hasArgon2 && "crypto.argon2 needs Node >= 24.7" }, async () => {
  const { hash, algorithm } = await hashPassword("another long passphrase", { algorithm: "argon2id", fast: true });
  assert.equal(algorithm, "argon2id");
  assert.match(hash, /^\$argon2id\$v=19\$m=64,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  const ok = await verifyPassword("another long passphrase", hash);
  assert.equal(ok.ok, true);
  assert.equal(ok.needsRehash, true); // test parameters are weaker than production ones
  assert.equal((await verifyPassword("wrong", hash)).ok, false);
  const full = await hashPassword("another long passphrase", { algorithm: "argon2id" });
  assert.ok(full.hash.startsWith(`$argon2id$v=19$m=${ARGON2_PARAMS.memoryKiB},t=${ARGON2_PARAMS.passes},p=1$`));
  assert.equal((await verifyPassword("another long passphrase", full.hash)).needsRehash, false);
});

test("Argon2id: accepts a hash produced by a different implementation (Python 'cryptography')", { skip: !hasArgon2 && "crypto.argon2 needs Node >= 24.7" }, async () => {
  const external = "$argon2id$v=19$m=19456,t=2,p=1$AAECAwQFBgcICQoLDA0ODw$htymluDZxAIM0Zl7elxYw5BrO6UjZSNTuUmaShwaFfw";
  assert.equal((await verifyPassword("correct horse battery staple 42", external)).ok, true);
  assert.equal((await verifyPassword("correct horse battery staple 43", external)).ok, false);
});

test("Argon2id known-answer test (RFC 9106 section 5.3)", { skip: !hasArgon2 && "crypto.argon2 needs Node >= 24.7" }, async () => {
  const argon2 = (crypto as unknown as {
    argon2: (a: string, p: Record<string, unknown>, cb: (e: Error | null, d: Buffer) => void) => void;
  }).argon2;
  const derived: Buffer = await new Promise((resolve, reject) =>
    argon2("argon2id", {
      message: Buffer.alloc(32, 1), nonce: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), associatedData: Buffer.alloc(12, 4),
      parallelism: 4, tagLength: 32, memory: 32, passes: 3,
    }, (e, d) => (e ? reject(e) : resolve(d))),
  );
  assert.equal(derived.toString("hex"), "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
});

test("password policy: length, common passwords, email, repeated character", () => {
  assert.deepEqual(checkPasswordPolicy("Tr0ub4dor&3x!long"), []);
  assert.ok(checkPasswordPolicy("short").includes("too_short"));
  assert.ok(checkPasswordPolicy("x".repeat(129)).includes("too_long"));
  assert.ok(checkPasswordPolicy("password1234").includes("too_common"));
  assert.ok(checkPasswordPolicy("headteacher-2026-ok", { email: "headteacher@school.test" }).includes("contains_email"));
  assert.ok(checkPasswordPolicy("aaaaaaaaaaaaaaaa").includes("all_same_character"));
  // length is counted in characters, not bytes
  assert.deepEqual(checkPasswordPolicy("\u{1F600}".repeat(12)).includes("too_short"), false);
});
