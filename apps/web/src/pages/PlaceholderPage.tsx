import { Link } from 'react-router-dom'
import type { NavItem } from '../app/navigation'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { Panel } from '../components/ui/Panel'

interface PlaceholderPageProps {
  item: NavItem
}

/** One shared page for every module that is not built yet. */
export function PlaceholderPage({ item }: PlaceholderPageProps) {
  return (
    <div className="page">
      <div className="page-heading">
        <h1>{item.label}</h1>
        <p>{item.description}</p>
      </div>

      <Panel title="Not built yet" badge={<Badge variant="planned">Planned</Badge>}>
        <EmptyState
          title={`${item.label} is not available in this demo`}
          description="This module is planned for a later phase. Nothing on this page works yet, and no data is stored."
          action={
            <Link to="/" className="btn btn--secondary">
              Back to dashboard
            </Link>
          }
        />
      </Panel>
    </div>
  )
}
