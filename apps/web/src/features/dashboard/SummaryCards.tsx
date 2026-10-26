import type { SummaryStat } from '../../types/dashboard'

interface SummaryCardsProps {
  stats: SummaryStat[]
}

export function SummaryCards({ stats }: SummaryCardsProps) {
  return (
    <ul className="stat-grid" aria-label="Summary figures (sample data)">
      {stats.map((stat) => (
        <li key={stat.id} className="stat-card">
          <p className="stat-card__label">{stat.label}</p>
          <p className="stat-card__value">{stat.value}</p>
          <p className="stat-card__helper">{stat.helper}</p>
        </li>
      ))}
    </ul>
  )
}
