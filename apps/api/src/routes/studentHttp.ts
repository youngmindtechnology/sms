import type { Response } from "express";
import { z } from "zod";
import type { Actor, Result, StudentErrorCode } from "../students/common.js";
import { getAuth } from "../http/middleware.js";

/** Shared by the students, guardians and enrollments routers. */
export const id = z.string().uuid();

const STATUS: Record<StudentErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  duplicate_admission_number: 409,
  invalid_status_change: 409,
  student_not_active: 409,
  already_linked: 409,
  already_enrolled: 409,
  year_closed: 409,
  class_inactive: 409,
  no_current_enrollment: 409,
};

export function send<T>(res: Response, result: Result<T>, success = 200, shape: (value: T) => unknown = (v) => v) {
  if (result.ok) return void res.status(success).json(shape(result.value));
  const body: { error: StudentErrorCode; fields?: Record<string, string> } = { error: result.error };
  if (result.fields) body.fields = result.fields;
  return void res.status(STATUS[result.error]).json(body);
}

export const badRequest = (res: Response) => void res.status(400).json({ error: "invalid_request" });

/** The school and user come from the verified session, never from the request. */
export function actorOf(res: Response): Actor {
  const context = getAuth(res)!;
  return { schoolId: context.school!.id, userId: context.user.id, canViewSensitive: context.school!.permissions.has("students:sensitive") };
}
