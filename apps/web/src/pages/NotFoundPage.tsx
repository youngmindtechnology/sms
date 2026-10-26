import { Link } from 'react-router-dom'
import { EmptyState } from '../components/ui/EmptyState'
import { Panel } from '../components/ui/Panel'

export function NotFoundPage() {
  return (
    <div className="page">
      <div className="page-heading">
        <h1>Page not found</h1>
      </div>

      <Panel title="This address does not exist">
        <EmptyState
          title="We could not find that page"
          description="Check the address, or use the navigation to go somewhere else."
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
