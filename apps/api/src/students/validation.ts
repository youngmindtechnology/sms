import { isCalendarDate } from "../academic/dates.js";
import { GUARDIAN_RELATIONSHIPS, STUDENT_STATUSES, type GuardianRelationship, type StudentStatus } from "./ports.js";

type Errors = Record<string, string>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Trim and squeeze inner spaces. Returns null (and records the error) when the value is unusable. */
export function cleanText(value: unknown, field: string, label: string, max: number, errors: Errors): string | null {
  if (typeof value !== "string") { errors[field] = `Enter ${label}.`; return null; }
  const text = value.trim().replace(/\s+/g, " ");
  if (CONTROL.test(text)) { errors[field] = `${capital(label)} contains characters that aren't allowed.`; return null; }
  if (text.length < 1 || text.length > max) { errors[field] = `${capital(label)} must be 1 to ${max} characters.`; return null; }
  return text;
}
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Optional text: undefined / null / empty string mean "none". */
export function cleanOptionalText(value: unknown, field: string, label: string, max: number, errors: Errors): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  return cleanText(value, field, label, max, errors) ?? undefined;
}

const ADMISSION = /^[A-Z0-9][A-Z0-9/._-]{0,39}$/;
/** Trim and upper-case (the database requires it), then allow letters, digits and / . _ - only. */
export function cleanAdmissionNumber(value: unknown, errors: Errors): string | null {
  if (typeof value !== "string") { errors.admissionNumber = "Enter an admission number."; return null; }
  const text = value.trim().toUpperCase();
  if (!ADMISSION.test(text)) {
    errors.admissionNumber = "Use 1 to 40 letters, numbers, / . _ or - (for example 2026/0001).";
    return null;
  }
  return text;
}

/** An optional calendar date. `maxDate` (inclusive) and `minDate` bound it. Returns undefined when absent. */
export function cleanOptionalDate(
  value: unknown, field: string, label: string, errors: Errors, bounds: { min?: string; max?: string } = {},
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!isCalendarDate(value)) { errors[field] = `Enter a valid ${label}.`; return undefined; }
  if (bounds.max && value > bounds.max) { errors[field] = `The ${label} can't be in the future.`; return undefined; }
  if (bounds.min && value < bounds.min) { errors[field] = `The ${label} is too long ago.`; return undefined; }
  return value;
}

/**
 * Ghana numbers may be typed locally ("024 123 4567") or internationally ("+233 24 123 4567").
 * Stored as E.164, which the database requires. Anything else is refused.
 */
export function cleanPhone(value: unknown, errors: Errors): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string") { errors.phone = "Enter a valid phone number."; return undefined; }
  let digits = value.replace(/[\s().-]/g, "");
  if (/^0\d{9}$/.test(digits)) digits = `+233${digits.slice(1)}`;
  else if (/^233\d{9}$/.test(digits)) digits = `+${digits}`;
  else if (/^00[1-9]\d{7,14}$/.test(digits)) digits = `+${digits.slice(2)}`;
  if (!/^\+[1-9][0-9]{7,14}$/.test(digits)) {
    errors.phone = "Enter a valid phone number, for example 024 123 4567 or +233 24 123 4567.";
    return undefined;
  }
  return digits;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function cleanEmail(value: unknown, errors: Errors): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value !== "string") { errors.email = "Enter a valid email address."; return undefined; }
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email) || CONTROL.test(email)) { errors.email = "Enter a valid email address."; return undefined; }
  return email;
}

export const isStudentStatus = (value: unknown): value is StudentStatus => typeof value === "string" && (STUDENT_STATUSES as readonly string[]).includes(value);
export const isRelationship = (value: unknown): value is GuardianRelationship => typeof value === "string" && (GUARDIAN_RELATIONSHIPS as readonly string[]).includes(value);

/** `a` is 30 years before `today` at most; a quick sanity bound for dates of birth. */
export const yearsBefore = (today: string, years: number) => `${Number(today.slice(0, 4)) - years}${today.slice(4)}`;
