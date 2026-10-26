/**
 * First-owner provisioning. There is no public registration, so the first school
 * owner is created by an operator running this command on the server.
 *
 *   npm run provision-owner --workspace=api -- \
 *     --school-code=kings-basic --school-name="Kings Basic School" \
 *     --email=owner@example.com --full-name="Ama Mensah" \
 *     --confirm-database=ymt_dev
 *
 * Reset a forgotten password (same safety checks):
 *   npm run provision-owner --workspace=api -- --reset-password --email=owner@example.com --confirm-database=ymt_dev
 *
 * The password is typed at a hidden prompt: it is never an argument, never in the
 * shell history, and never printed. The command refuses to run unless
 * --confirm-database exactly matches the database name in DATABASE_URL.
 */
import fs from "node:fs";
import { loadConfigFromEnvOrExit } from "./shared.js";
import { hashPassword, checkPasswordPolicy } from "../auth/password.js";
import { assertAuditSafe } from "../auth/audit.js";
import { prisma } from "../lib/prisma.js";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function databaseNameOf(url: string | undefined): { name: string; host: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { name: decodeURIComponent(u.pathname.replace(/^\//, "")), host: `${u.hostname}:${u.port || "5432"}` };
  } catch {
    return null;
  }
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("A hidden password prompt needs an interactive terminal."));
    process.stdout.write(prompt);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") { cleanup(); return reject(new Error("Cancelled.")); }
        if (ch === "\r" || ch === "\n") { cleanup(); process.stdout.write("\n"); return resolve(value); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  if (fs.existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
  loadConfigFromEnvOrExit();

  if (process.argv.includes("--reset-password")) return resetPassword();

  const schoolCode = arg("school-code")?.trim().toLowerCase();
  const schoolName = arg("school-name")?.trim();
  const email = arg("email")?.trim().toLowerCase();
  const fullName = arg("full-name")?.trim();
  const confirm = arg("confirm-database");
  if (!schoolCode || !schoolName || !email || !fullName || !confirm) {
    throw new Error("Required: --school-code --school-name --email --full-name --confirm-database");
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(schoolCode) || schoolCode.length < 3 || schoolCode.length > 40) {
    throw new Error("--school-code must be 3-40 characters: lowercase letters and digits, with single hyphens between parts (for example kings-basic).");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("--email is not a valid address.");

  const target = databaseNameOf(process.env.DATABASE_URL);
  if (!target) throw new Error("DATABASE_URL is missing or unreadable.");
  if (target.name !== confirm) {
    throw new Error(`--confirm-database does not match the database in DATABASE_URL (which is "${target.name}"). Nothing was changed.`);
  }
  console.log(`Target database: "${target.name}" at ${target.host}`);

  const password = await readHidden("Password for the new owner (hidden): ");
  const again = await readHidden("Repeat password: ");
  if (password !== again) throw new Error("The passwords did not match. Nothing was changed.");
  const problems = checkPasswordPolicy(password, { email });
  if (problems.length) throw new Error(`Password rejected: ${problems.join(", ")}. Nothing was changed.`);

  const hashed = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, include: { credential: true } });
    if (existing?.credential) throw new Error("A user with this email already has a password. Nothing was changed.");

    const school =
      (await tx.school.findUnique({ where: { code: schoolCode } })) ??
      (await tx.school.create({ data: { code: schoolCode, name: schoolName } }));

    const user = existing ?? (await tx.user.create({ data: { email, fullName, status: "ACTIVE" } }));
    if (existing && existing.status !== "ACTIVE") await tx.user.update({ where: { id: existing.id }, data: { status: "ACTIVE" } });

    await tx.userCredential.create({
      data: { userId: user.id, passwordHash: hashed.hash, algorithm: hashed.algorithm },
    });

    const membership = await tx.schoolMembership.upsert({
      where: { schoolId_userId: { schoolId: school.id, userId: user.id } },
      create: { schoolId: school.id, userId: user.id, status: "ACTIVE" },
      update: { status: "ACTIVE", endedAt: null },
    });
    await tx.schoolMembershipRole.upsert({
      where: { membershipId_role: { membershipId: membership.id, role: "OWNER" } },
      create: { membershipId: membership.id, role: "OWNER" },
      update: {},
    });

    const metadata = { schoolCode, via: "provision-owner-cli" };
    assertAuditSafe(metadata);
    await tx.auditEvent.create({
      data: { schoolId: school.id, actorUserId: null, action: "owner.provisioned", entityType: "user", entityId: user.id, metadata },
    });
    console.log(`Created owner ${email} for school ${schoolCode}.`);
  });
}

/** Operator-only password reset for an existing account. Changes nothing else about the user. */
async function resetPassword() {
  const email = arg("email")?.trim().toLowerCase();
  const confirm = arg("confirm-database");
  if (!email || !confirm) throw new Error("Required with --reset-password: --email --confirm-database");

  const target = databaseNameOf(process.env.DATABASE_URL);
  if (!target) throw new Error("DATABASE_URL is missing or unreadable.");
  if (target.name !== confirm) {
    throw new Error(`--confirm-database does not match the database in DATABASE_URL (which is "${target.name}"). Nothing was changed.`);
  }
  console.log(`Target database: "${target.name}" at ${target.host}`);

  const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, include: { credential: true } });
  if (!user || !user.credential) throw new Error("No account with a password exists for that email. Nothing was changed.");

  const password = await readHidden("New password (hidden): ");
  const again = await readHidden("Repeat new password: ");
  if (password !== again) throw new Error("The passwords did not match. Nothing was changed.");
  const problems = checkPasswordPolicy(password, { email });
  if (problems.length) throw new Error(`Password rejected: ${problems.join(", ")}. Nothing was changed.`);

  const hashed = await hashPassword(password);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.userCredential.update({
      where: { userId: user.id },
      data: { passwordHash: hashed.hash, algorithm: hashed.algorithm, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
    });
    const ended = await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: "admin_revoked" },
    });
    const metadata = { via: "provision-owner-cli", sessionsEnded: ended.count };
    assertAuditSafe(metadata);
    await tx.auditEvent.create({
      data: { schoolId: null, actorUserId: null, action: "password.reset_by_operator", entityType: "user", entityId: user.id, metadata },
    });
  });
  console.log(`Password reset for ${email}. Any open sessions were ended and the lockout was cleared.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Provisioning failed.");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
