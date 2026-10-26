import { formatCount, formatCurrency } from '../../lib/format'
import type { DashboardSample, SummaryStat } from '../../types/dashboard'

/**
 * Turns raw dashboard data into the four display-ready summary cards.
 * Totals are DERIVED from the rows, never typed in twice, so the cards
 * and the enrollment chart can never disagree with each other.
 */
export function buildSummaryStats(data: DashboardSample): SummaryStat[] {
  const totalStudents = data.enrollment.reduce(
    (sum, row) => sum + row.students,
    0,
  )
  const totalClasses = data.enrollment.reduce(
    (sum, row) => sum + row.classes,
    0,
  )
  const { billed, collected } = data.fees
  const outstanding = billed - collected
  const collectedPercent = billed > 0 ? Math.round((collected / billed) * 100) : 0

  return [
    {
      id: 'students',
      label: 'Total students',
      value: formatCount(totalStudents),
      helper: 'Across all levels',
    },
    {
      id: 'classes',
      label: 'Classes',
      value: formatCount(totalClasses),
      helper: 'Nursery to JHS',
    },
    {
      id: 'outstanding',
      label: 'Outstanding fees',
      value: formatCurrency(outstanding),
      helper: `${100 - collectedPercent}% of billed fees`,
    },
    {
      id: 'collected',
      label: 'Fees collected',
      value: formatCurrency(collected),
      helper: `${collectedPercent}% of ${formatCurrency(billed)} billed`,
    },
  ]
}
