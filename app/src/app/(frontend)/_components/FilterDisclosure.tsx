import Link from 'next/link'

import type { ReactNode } from 'react'

import '../workflow-primitives.css'

type FilterDisclosureProps = {
  activeCount: number
  children: ReactNode
  clearHref: string
}

export function FilterDisclosure({ activeCount, children, clearHref }: FilterDisclosureProps) {
  return (
    <div className="workflow-filter-disclosure-row">
      <details className="workflow-filter-disclosure" open={activeCount > 0 || undefined}>
        <summary>
          <span>More filters</span>
          {activeCount > 0 && (
            <span className="workflow-filter-count">
              {activeCount} active {activeCount === 1 ? 'filter' : 'filters'}
            </span>
          )}
        </summary>
        <div className="workflow-filter-disclosure-content">{children}</div>
      </details>

      <Link className="workflow-clear-filters" href={clearHref}>
        Clear filters
      </Link>
    </div>
  )
}
