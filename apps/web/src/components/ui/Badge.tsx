import type { ReactNode } from 'react'

interface BadgeProps {
  variant: 'sample' | 'planned' | 'active' | 'closed'
  children: ReactNode
}

/** A short status label, e.g. "Sample data" or "Planned". */
export function Badge({ variant, children }: BadgeProps) {
  return <span className={`badge badge--${variant}`}>{children}</span>
}
