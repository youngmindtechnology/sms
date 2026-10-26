import fs from "node:fs";
import { createAcademicService } from "./academic/academicService.js";
import { createClassService } from "./classes/classService.js";
import { createAuthService } from "./auth/authService.js";
import { ConfigError, loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { createPrismaAcademicRepository } from "./repositories/prismaAcademicRepository.js";
import { createPrismaClassRepository } from "./repositories/prismaClassRepository.js";
import { createPrismaAuthRepository } from "./repositories/prismaAuthRepository.js";

// Load apps/api/.env (if present) before validating the environment. Variables that
// are already set in the shell win, as with Prisma. Values are never printed.
if (fs.existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const auth = createAuthService(createPrismaAuthRepository(prisma), config);
const academic = createAcademicService(createPrismaAcademicRepository(prisma));
const classes = createClassService(createPrismaClassRepository(prisma));
const app = createApp({ config, auth, academic, classes });

app.listen(config.port, () => {
  console.log(`YMT API listening on http://localhost:${config.port}`);
});
