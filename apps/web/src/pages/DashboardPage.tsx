import { Badge } from '../components/ui/Badge'
import { Panel } from '../components/ui/Panel'
import { sampleDashboard } from '../data/sampleDashboard'
import { EnrollmentChart } from '../features/dashboard/EnrollmentChart'
import { RecentActivity } from '../features/dashboard/RecentActivity'
import { SummaryCards } from '../features/dashboard/SummaryCards'
import { buildSummaryStats } from '../features/dashboard/summary'

export function DashboardPage() {
  const data = sampleDashboard
  const stats = buildSummaryStats(data)

  return (
    <div className="page">
      <div className="page-heading">
        <h1>Welcome to YMT School Management</h1>
        <p>
          Overview for {data.schoolName}, {data.termLabel}. This is a
          fictional school used to preview the interface.
        </p>
      </div>

      <SummaryCards stats={stats} />

      <div className="dashboard-grid">
        <Panel
          title="Enrollment by level"
          badge={<Badge variant="sample">Sample data</Badge>}
        >
          <EnrollmentChart rows={data.enrollment} />
        </Panel>

        <Panel
          title="Recent activity"
          badge={<Badge variant="sample">Sample data</Badge>}
        >
          <RecentActivity items={data.recentActivity} />
        </Panel>
      </div>
    </div>
  )
}
