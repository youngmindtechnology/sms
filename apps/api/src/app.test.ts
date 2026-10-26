import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import request from "supertest";
import app from "./app.js";

before(() => {
  process.env.NODE_ENV = "test";
});

after(() => {
  // No server is started by these tests.
});

test("GET /api/health returns a successful health response", async () => {
  const response = await request(app).get("/api/health");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: "ok",
    service: "ymt-school-management-api",
  });
});

test("health response includes security headers", async () => {
  const response = await request(app).get("/api/health");

  assert.equal(response.headers["x-powered-by"], undefined);
  assert.ok(response.headers["x-content-type-options"]);
});

test("health endpoint allows the configured frontend origin", async () => {
  const response = await request(app)
    .get("/api/health")
    .set("Origin", "http://localhost:5173");

  assert.equal(response.status, 200);
  assert.equal(
    response.headers["access-control-allow-origin"],
    "http://localhost:5173",
  );
});

test("unknown routes return 404", async () => {
  const response = await request(app).get("/api/does-not-exist");

  assert.equal(response.status, 404);
});
