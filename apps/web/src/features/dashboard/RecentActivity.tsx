import { EmptyState } from '../../components/ui/EmptyState'
import type { ActivityItem } from '../../types/dashboard'

interface RecentActivityProps {
  items: ActivityItem[]
}

export function RecentActivity({ items }: RecentActivityProps) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="No recent activity"
        description="Activity such as new enrollments and payments will be listed here."
      />
    )
  }

  return (
    <ul>
      {items.map((item) => (
        <li key={item.id} className="activity-item">
          <span className="activity-item__kind">{item.kind}</span>
          <div>
            <p>{item.description}</p>
            <p className="activity-item__time">{item.timeLabel}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
