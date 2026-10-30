/**
 * The name of an academic year is made from its dates, the way schools write it: a year that runs
 * from September 2026 to July 2027 is "2026/2027". A year inside one calendar year is just "2026".
 * Returns '' until both dates are valid.
 */
export function academicYearName(startDate: string, endDate: string): string {
  const start = /^(\d{4})-\d{2}-\d{2}$/.exec(startDate)
  const end = /^(\d{4})-\d{2}-\d{2}$/.exec(endDate)
  if (!start || !end) return ''
  return start[1] === end[1] ? start[1] : `${start[1]}/${end[1]}`
}