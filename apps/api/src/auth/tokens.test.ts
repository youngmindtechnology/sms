import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveCsrfToken, generateToken, hashToken, looksLikeToken, safeEqual } from "./tokens.js";

test("tokens are 43 URL-safe characters (256 bits) and never repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i += 1) {
    const token = generateToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(looksLikeToken(token));
    seen.add(token);
  }
  assert.equal(seen.size, 2000);
});

test("the stored hash is 32 bytes, deterministic, and differs from the token", () => {
  const token = generateToken();
  const hash = hashToken(token);
  assert.equal(hash.length, 32);
  assert.ok(hash.equals(hashToken(token)));
  assert.ok(!hash.toString("base64url").includes(token));
});

test("the CSRF token is derived: stable per session, different between sessions and from the session token", () => {
  const a = generateToken();
  const b = generateToken();
  assert.equal(deriveCsrfToken(a), deriveCsrfToken(a));
  assert.notEqual(deriveCsrfToken(a), deriveCsrfToken(b));
  assert.notEqual(deriveCsrfToken(a), a);
  assert.ok(looksLikeToken(deriveCsrfToken(a)));
});

test("safeEqual compares content and tolerates different lengths", () => {
  assert.equal(safeEqual(Buffer.from("abc"), Buffer.from("abc")), true);
  assert.equal(safeEqual(Buffer.from("abc"), Buffer.from("abd")), false);
  assert.equal(safeEqual(Buffer.from("abc"), Buffer.from("abcd")), false);
});

test("looksLikeToken rejects junk before any database lookup", () => {
  for (const junk of [undefined, null, 5, "", "short", "x".repeat(44), `${"a".repeat(42)}!`, "a b".repeat(15)]) {
    assert.equal(looksLikeToken(junk), false);
  }
});
