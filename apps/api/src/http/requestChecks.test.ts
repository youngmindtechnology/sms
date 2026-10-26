import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter } from "./rateLimiter.js";
import { isTrustedOrigin, isUnsafeMethod, readCookie } from "./requestChecks.js";

test("rate limiter: allows up to the limit, then refuses with a retry time, then resets", () => {
  const limiter = new RateLimiter({ windowMs: 60_000, limit: 3 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.check("ip-1", t0 + i).allowed, true);
  const blocked = limiter.check("ip-1", t0 + 10);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 59 && blocked.retryAfterSeconds <= 60);
  assert.equal(limiter.check("ip-2", t0 + 10).allowed, true, "other keys are independent");
  assert.equal(limiter.check("ip-1", t0 + 60_001).allowed, true, "window reset");
});

test("rate limiter: memory stays bounded under a flood of distinct keys", () => {
  const limiter = new RateLimiter({ windowMs: 60_000, limit: 1, maxKeys: 100 });
  for (let i = 0; i < 10_000; i += 1) limiter.check(`k${i}`, 5_000);
  const size = (limiter as unknown as { hits: Map<string, unknown> }).hits.size;
  assert.ok(size <= 100, `size ${size}`);
});

test("origin check: exact match only", () => {
  const allowed = "http://localhost:5173";
  assert.equal(isTrustedOrigin("http://localhost:5173", allowed), true);
  for (const bad of [undefined, "", "null", "http://localhost:5174", "https://localhost:5173", "http://localhost:5173/", "http://evil.test", "http://localhost:5173.evil.test"]) {
    assert.equal(isTrustedOrigin(bad, allowed), false, String(bad));
  }
});

test("unsafe methods", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) assert.equal(isUnsafeMethod(m), true, m);
  for (const m of ["GET", "HEAD", "OPTIONS"]) assert.equal(isUnsafeMethod(m), false, m);
});

test("cookie parsing", () => {
  assert.equal(readCookie("a=1; ymt_session=abc; b=2", "ymt_session"), "abc");
  assert.equal(readCookie("ymt_session=abc", "ymt_session"), "abc");
  assert.equal(readCookie("xymt_session=abc", "ymt_session"), undefined);
  assert.equal(readCookie(undefined, "ymt_session"), undefined);
  assert.equal(readCookie("ymt_session=%E0%A4%A", "ymt_session"), undefined); // bad encoding: no throw
  assert.equal(readCookie("ymt_session=first; ymt_session=second", "ymt_session"), "first");
});
