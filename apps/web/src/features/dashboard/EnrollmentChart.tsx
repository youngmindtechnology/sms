import { EmptyState } from '../../components/ui/EmptyState'
import { formatCount } from '../../lib/format'
import type { EnrollmentByLevel } from '../../types/dashboard'

interface EnrollmentChartProps {
  rows: EnrollmentByLevel[]
}

/**
 * Horizontal bars showing each level's share of total enrollment.
 * The bars are decorative (aria-hidden); the numbers beside them carry
 * the same information as text, so nothing depends on seeing the bars.
 */
export function EnrollmentChart({ rows }: EnrollmentChartProps) {
  const total = rows.reduce((sum, row) => sum + row.students, 0)

  if (total === 0) {
    return (
      <EmptyState
        title="No enrollment data"
        description="Enrollment by level will appear here once students are registered."
      />
    )
  }

  return (
    <>
      <ul className="bar-list">
        {rows.map((row) => {
          const share = (row.students / total) * 100
          return (
            <li key={row.level}>
              <div className="bar-row__meta">
                <span className="bar-row__level">{row.level}</span>
                <span className="bar-row__value">
                  {formatCount(row.students)} students ({Math.round(share)}%)
                </span>
              </div>
              <div className="bar-track" aria-hidden="true">
                <div className="bar-fill" style={{ width: `${share}%` }} />
              </div>
            </li>
          )
        })}
      </ul>
      <p className="chart-note">
        Bar length shows each level's share of all {formatCount(total)}{' '}
        enrolled students.
      </p>
    </>
  )
}
