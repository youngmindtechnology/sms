import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const base = { DATABASE_URL: "postgresql://app:SENTINEL-secret-1@localhost:5432/ymt_dev" };

test("defaults for development", () => {
  const c = loadConfig(base);
  assert.equal(c.env, "development");
  assert.equal(c.port, 3000);
  assert.equal(c.frontendOrigin, "http://localhost:5173");
  assert.equal(c.session.cookieName, "ymt_session");
  assert.equal(c.session.secureCookie, false);
  assert.equal(c.trustProxyHops, 0);
});

test("production: Secure __Host- cookie and https origin required", () => {
  const c = loadConfig({ ...base, NODE_ENV: "production", FRONTEND_ORIGIN: "https://school.example" });
  assert.equal(c.session.secureCookie, true);
  assert.equal(c.session.cookieName, "__Host-ymt_session");
  assert.throws(() => loadConfig({ ...base, NODE_ENV: "production", FRONTEND_ORIGIN: "http://school.example" }), ConfigError);
});

test("bad values are rejected and the DATABASE_URL value is never printed", () => {
  for (const env of [
    { ...base, PORT: "0" }, { ...base, PORT: "70000" }, { ...base, PORT: "abc" },
    { ...base, FRONTEND_ORIGIN: "http://localhost:5173/" }, { ...base, FRONTEND_ORIGIN: "not a url" },
    { ...base, FRONTEND_ORIGIN: "ftp://x.test" }, { ...base, SESSION_TTL_HOURS: "0" },
    { ...base, LOGIN_MAX_FAILURES: "1" }, { ...base, TRUST_PROXY_HOPS: "9" }, { ...base, NODE_ENV: "staging" },
    { DATABASE_URL: "mysql://u:SENTINEL-secret-1@h/db" }, {},
  ]) {
    assert.throws(() => loadConfig(env as NodeJS.ProcessEnv), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(!String(error.message).includes("SENTINEL"), "secret leaked into error");
      return true;
    });
  }
});
