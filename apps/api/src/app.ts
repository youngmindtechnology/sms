import cors from "cors";
import express from "express";
import helmet from "helmet";
import type { AcademicService } from "./academic/academicService.js";
import type { AuthService } from "./auth/authService.js";
import type { ClassService } from "./classes/classService.js";
import type { AppConfig } from "./config.js";
import { errorHandler } from "./http/middleware.js";
import healthRouter from "./routes/health.js";
import { createAcademicRouter } from "./routes/academic.js";
import { createClassRouter } from "./routes/classes.js";
import { createAuthRouter, type AuthRouteOptions } from "./routes/auth.js";

export interface AppOptions {
  /** Validated configuration. Required together with `auth` to enable /api/auth. */
  config?: AppConfig;
  auth?: AuthService;
  academic?: AcademicService;
  classes?: ClassService;
  authRoutes?: AuthRouteOptions;
}

/**
 * Builds the Express application. Called without options it serves only the health
 * routes (this is what the original tests use); the server passes config and the
 * authentication service to enable /api/auth.
 */
export function createApp(options: AppOptions = {}) {
  const app = express();

  const allowedOrigin = options.config?.frontendOrigin ?? process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";

  app.disable("x-powered-by");
  if (options.config && options.config.trustProxyHops > 0) app.set("trust proxy", options.config.trustProxyHops);
  app.use(helmet());

  app.use(
    cors({
      origin: allowedOrigin,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "X-CSRF-Token"],
      // Required so the browser sends and accepts the session cookie. Only the one
      // configured origin is ever allowed (never "*").
      credentials: true,
    }),
  );

  app.use(express.json({ limit: "100kb" }));

  app.use("/api/health", healthRouter);

  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "ymt-school-management-api",
    });
  });

  if (options.config && options.auth) {
    app.use("/api/auth", createAuthRouter(options.auth, options.config, options.authRoutes));
  }

  if (options.config && options.auth && options.academic) {
    app.use("/api/academic-years", createAcademicRouter(options.auth, options.academic, options.config));
  }

  if (options.config && options.auth && options.classes) {
    app.use("/api/classes", createClassRouter(options.auth, options.classes, options.config));
  }

  app.use(errorHandler);

  return app;
}

const app = createApp();

export default app;
