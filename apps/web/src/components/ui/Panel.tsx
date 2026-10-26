import { useId } from 'react'
import type { ReactNode } from 'react'

interface PanelProps {
  title: string
  /** Optional element shown at the right of the title, e.g. a Badge. */
  badge?: ReactNode
  children: ReactNode
}

/**
 * A titled content block. The <section> is labelled by its heading
 * (aria-labelledby) so screen readers announce it as a named region.
 * useId() gives every Panel a unique id without us managing counters.
 */
export function Panel({ title, badge, children }: PanelProps) {
  const headingId = useId()

  return (
    <section className="panel" aria-labelledby={headingId}>
      <div className="panel__header">
        <h2 id={headingId}>{title}</h2>
        {badge}
      </div>
      <div className="panel__body">{children}</div>
    </section>
  )
}
