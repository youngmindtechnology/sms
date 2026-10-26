/** Calendar-date helpers. Dates are "YYYY-MM-DD" strings; ISO format compares correctly as text. */
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SHAPE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2000 || year > 2100) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

/** Inclusive ranges overlap when each starts on or before the other ends. */
export const rangesOverlap = (a: { startDate: string; endDate: string }, b: { startDate: string; endDate: string }) =>
  a.startDate <= b.endDate && b.startDate <= a.endDate;

export const isInside = (inner: { startDate: string; endDate: string }, outer: { startDate: string; endDate: string }) =>
  inner.startDate >= outer.startDate && inner.endDate <= outer.endDate;
