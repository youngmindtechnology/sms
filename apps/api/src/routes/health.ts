
import { Router } from "express";
import { prisma } from "../lib/prisma.js";

const healthRouter = Router();

healthRouter.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return res.status(200).json({
      status: "ready",
      database: "connected",
    });
  } catch {
    return res.status(503).json({
      status: "not_ready",
      database: "unavailable",
    });
  }
});

export default healthRouter;
