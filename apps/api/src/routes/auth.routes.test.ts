import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import request from "supertest";
import { createApp } from "../app.js";
import { createAuthService } from "../auth/authService.js";
import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { getAuth, requireAuth, requirePermission, requireSchool } from "../http/middleware.js";
import { RateLimiter } from "../http/rateLimiter.js";
import { MemoryRepository } from "../testing/memoryRepository.js";

const ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery staple";
const SCHOOL_A = "10000000-0000-4000-8000-0000000000a1";
const SCHOOL_B = "10000000-0000-4000-8000-0000000000b1";
const SCHOOL_X = "10000000-0000-4000-8000-0000000000ee";

const config = loadConfig({ DATABASE_URL: "postgresql://app:SENTINEL-db-secret@localhost:5432/ymt_dev", FRONTEND_ORIGIN: ORIGIN });

async function build(options: { loginLimit?: number } = {}) {
  const repo = new MemoryRepository();
  const { hash, algorithm } = await hashPassword(PASSWORD, { algorithm: "scrypt", fast: true });
  const owner = repo.addUser({ email: "owner@example.test", fullName: "Test Owner", status: "ACTIVE" }, { passwordHash: hash, algorithm });
  repo.addMembership(owner.id, { schoolId: SCHOOL_A, schoolName: "Alpha", schoolStatus: "ACTIVE", status: "ACTIVE", roles: ["OWNER"] });
  repo.addMembership(owner.id, { schoolId: SCHOOL_B, schoolName: "Bravo", schoolStatus: "ACTIVE", status: "ACTIVE", roles: ["TEACHER"] });
  const auth = createAuthService(repo, config);
  const app = createApp({
    config, auth,
    authRoutes: { loginLimiter: new RateLimiter({ windowMs: 60_000, limit: options.loginLimit ?? 100 }) },
  });
  return { app, repo, auth };
}

/** Signs in and returns what a browser would keep: the cookie, and the CSRF token from the body. */
async function signIn(app: express.Express) {
  const res = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: "owner@example.test", password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
  return { res, cookie: cookie.split(";")[0]!, setCookie: cookie, csrf: res.body.csrfToken as string };
}

test("login: sets an HttpOnly SameSite=Strict cookie and never puts the session token in the body", async () => {
  const { app } = await build();
  const { res, cookie, setCookie } = await signIn(app);
  assert.match(setCookie, /^ymt_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Secure/i, "development cookies are not Secure; production ones are (see config test)");
  assert.equal(res.headers["cache-control"], "no-store");
  const token = cookie.split("=")[1]!;
  const body = JSON.stringify(res.body);
  for (const forbidden of [token, PASSWORD, "passwordHash", "argon2", "scrypt$", "tokenHash"]) assert.ok(!body.includes(forbidden), `body leaked ${forbidden.slice(0, 8)}`);
  assert.equal(res.body.user.email, "owner@example.test");
  assert.equal(res.body.activeSchoolId, null); // two schools: the person chooses
  assert.equal(res.body.schools.length, 2);
});

test("login: wrong origin or missing origin is refused before any password check", async () => {
  const { app, repo } = await build();
  for (const origin of [undefined, "http://evil.test", "null"]) {
    const req = request(app).post("/api/auth/login");
    if (origin) req.set("Origin", origin);
    const res = await req.send({ email: "owner@example.test", password: PASSWORD });
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.headers["set-cookie"], undefined);
  }
  assert.equal(repo.sessions.size, 0);
});

test("login: every failure gives the same 401 body and no cookie", async () => {
  const { app } = await build();
  const attempts = [
    { email: "nobody@example.test", password: PASSWORD },
    { email: "owner@example.test", password: "wrong password!!" },
  ];
  const bodies = [];
  for (const attempt of attempts) {
    const res = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send(attempt);
    assert.equal(res.status, 401);
    assert.equal(res.headers["set-cookie"], undefined);
    bodies.push(JSON.stringify(res.body));
  }
  assert.equal(bodies[0], bodies[1]);
});

test("login: malformed, oversized and unexpected input is a 400 and is never echoed back", async () => {
  const { app } = await build();
  const send = (body: unknown) => request(app).post("/api/auth/login").set("Origin", ORIGIN).send(body as object);
  assert.equal((await send({})).status, 400);
  assert.equal((await send({ email: "a@b.test" })).status, 400);
  assert.equal((await send({ email: "a@b.test", password: 5 })).status, 400);
  assert.equal((await send({ email: "a@b.test", password: "x".repeat(2000) })).status, 400);
  assert.equal((await send({ email: "a@b.test", password: "pw", isAdmin: true })).status, 400, "unknown fields are rejected");
  const broken = await request(app).post("/api/auth/login").set("Origin", ORIGIN).set("Content-Type", "application/json").send('{"password":"SENTINEL-typed-password');
  assert.equal(broken.status, 400);
  assert.ok(!JSON.stringify(broken.body).includes("SENTINEL"));
});

test("login: rate limited per client address", async () => {
  const { app } = await build({ loginLimit: 3 });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: "nobody@example.test", password: "whatever password" });
    statuses.push(res.status);
    if (res.status === 429) assert.ok(Number(res.headers["retry-after"]) >= 1);
  }
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
});

test("me: 401 without a session, with junk, and with an Authorization header instead of the cookie", async () => {
  const { app } = await build();
  assert.equal((await request(app).get("/api/auth/me")).status, 401);
  assert.equal((await request(app).get("/api/auth/me").set("Cookie", "ymt_session=junk")).status, 401);
  assert.equal((await request(app).get("/api/auth/me").set("Cookie", `ymt_session=${"A".repeat(43)}`)).status, 401);
  const { res } = await signIn(app);
  assert.equal((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.csrfToken}`)).status, 401);
});

test("me: returns the user, schools and a CSRF token that matches the login one", async () => {
  const { app } = await build();
  const { cookie, csrf } = await signIn(app);
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(me.status, 200);
  assert.equal(me.body.csrfToken, csrf);
  assert.equal(me.body.school, null);
  assert.equal(me.body.user.fullName, "Test Owner");
  assert.ok(!JSON.stringify(me.body).includes(cookie.split("=")[1]!));
});

test("state-changing calls need the trusted Origin AND the CSRF header", async () => {
  const { app } = await build();
  const { cookie, csrf } = await signIn(app);
  const post = (headers: Record<string, string>) => request(app).post("/api/auth/switch-school").set("Cookie", cookie).set(headers).send({ schoolId: SCHOOL_A });
  assert.equal((await post({ "X-CSRF-Token": csrf })).status, 403, "no Origin");
  assert.equal((await post({ Origin: ORIGIN })).status, 403, "no CSRF token");
  assert.equal((await post({ Origin: ORIGIN, "X-CSRF-Token": "A".repeat(43) })).status, 403, "wrong CSRF token");
  assert.equal((await post({ Origin: "http://evil.test", "X-CSRF-Token": csrf })).status, 403, "wrong origin");
  const ok = await post({ Origin: ORIGIN, "X-CSRF-Token": csrf });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.activeSchoolId, SCHOOL_A);
});

test("switch-school: a school the user does not belong to is refused with the same answer as a missing one; garbage is a 400", async () => {
  const { app, repo } = await build();
  const { cookie, csrf } = await signIn(app);
  const switchTo = (schoolId: unknown) =>
    request(app).post("/api/auth/switch-school").set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", csrf).send({ schoolId });
  const stranger = await switchTo(SCHOOL_X);
  assert.equal(stranger.status, 403);
  assert.deepEqual(stranger.body, { error: "forbidden" });
  assert.equal((await switchTo("not-a-uuid")).status, 400);
  assert.equal((await switchTo(undefined)).status, 400);
  const session = [...repo.sessions.values()][0]!;
  assert.equal(session.activeSchoolId, null, "refused switches change nothing");
  assert.equal((await switchTo(SCHOOL_B)).status, 200);
  const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
  assert.equal(me.body.school.id, SCHOOL_B);
  assert.deepEqual(me.body.school.roles, ["TEACHER"]);
  assert.ok(!me.body.school.permissions.includes("payments:record"));
});

test("logout: needs CSRF, revokes the session, clears the cookie", async () => {
  const { app } = await build();
  const { cookie, csrf } = await signIn(app);
  assert.equal((await request(app).post("/api/auth/logout").set("Cookie", cookie).set("Origin", ORIGIN)).status, 403);
  const out = await request(app).post("/api/auth/logout").set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", csrf);
  assert.equal(out.status, 204);
  assert.match(String((out.headers["set-cookie"] as unknown as string[])[0]), /ymt_session=;/);
  assert.equal((await request(app).get("/api/auth/me").set("Cookie", cookie)).status, 401, "the old cookie is dead even if replayed");
});

test("change-password: 400 for a wrong current or weak new password (not 401), 204 on success, old password then fails", async () => {
  const { app } = await build();
  const { cookie, csrf } = await signIn(app);
  const change = (body: object) =>
    request(app).post("/api/auth/change-password").set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", csrf).send(body);
  const wrong = await change({ currentPassword: "not my password", newPassword: "A brand new passphrase" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "wrong_password");
  const weak = await change({ currentPassword: PASSWORD, newPassword: "short" });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error, "weak_password");
  assert.ok(weak.body.problems.includes("too_short"));
  assert.equal((await change({ currentPassword: PASSWORD, newPassword: "A brand new passphrase" })).status, 204);
  const oldLogin = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: "owner@example.test", password: PASSWORD });
  assert.equal(oldLogin.status, 401);
  const newLogin = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: "owner@example.test", password: "A brand new passphrase" });
  assert.equal(newLogin.status, 200);
});

test("school-scoped routes: 401 vs 403, and a school id sent by the client is ignored", async () => {
  const { app: base, repo, auth } = await build();
  // A throwaway app that mounts the real middleware on example routes.
  const probe = express();
  probe.use(express.json());
  probe.get("/probe/school", requireAuth(auth, config), requireSchool, (_req, res) => {
    res.json({ schoolId: getAuth(res)!.school!.id });
  });
  probe.get("/probe/payments", requireAuth(auth, config), requirePermission("payments:record"), (_req, res) => {
    res.json({ ok: true });
  });

  const { cookie, csrf } = await signIn(base);
  assert.equal((await request(probe).get("/probe/school")).status, 401, "no session");
  const noSchool = await request(probe).get("/probe/school").set("Cookie", cookie);
  assert.equal(noSchool.status, 403, "signed in but no active school");
  assert.deepEqual(noSchool.body, { error: "school_required" });

  await request(base).post("/api/auth/switch-school").set("Cookie", cookie).set("Origin", ORIGIN).set("X-CSRF-Token", csrf).send({ schoolId: SCHOOL_B });
  // The client names another school in the query, the body and a header: all ignored.
  const scoped = await request(probe).get(`/probe/school?schoolId=${SCHOOL_A}`).set("Cookie", cookie).set("X-School-Id", SCHOOL_A);
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.schoolId, SCHOOL_B);
  assert.equal((await request(probe).get("/probe/payments").set("Cookie", cookie)).status, 403, "TEACHER cannot record payments");
  assert.equal((await request(probe).get("/probe/payments").set("Cookie", cookie)).body.error, "insufficient_permission");

  // Membership ended after login: the very next request loses the school.
  repo.memberships.get([...repo.users.values()][0]!.id)![1]!.status = "ENDED";
  assert.equal((await request(probe).get("/probe/school").set("Cookie", cookie)).status, 403);
});

test("CORS: credentials allowed for the configured origin only", async () => {
  const { app } = await build();
  const allowed = await request(app).options("/api/auth/login").set("Origin", ORIGIN).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type,x-csrf-token");
  assert.equal(allowed.headers["access-control-allow-origin"], ORIGIN);
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");
  const other = await request(app).options("/api/auth/login").set("Origin", "http://evil.test").set("Access-Control-Request-Method", "POST");
  assert.notEqual(other.headers["access-control-allow-origin"], "http://evil.test");
  assert.notEqual(other.headers["access-control-allow-origin"], "*");
});

test("nothing secret appears in server logs during a login and a failed login", async () => {
  const { app } = await build();
  const lines: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: "owner@example.test", password: PASSWORD });
    await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email: "owner@example.test", password: "SENTINEL-wrong-password" });
    await request(app).post("/api/auth/login").set("Origin", ORIGIN).set("Content-Type", "application/json").send('{"password":"SENTINEL-broken');
  } finally {
    Object.assign(console, original);
  }
  assert.ok(!lines.join("\n").includes("SENTINEL"));
  assert.ok(!lines.join("\n").includes(PASSWORD));
});
