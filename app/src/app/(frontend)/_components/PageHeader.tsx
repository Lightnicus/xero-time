import Link from 'next/link'

import type { ReactNode } from 'react'

import '../workflow-primitives.css'

type PageHeaderBreadcrumb = {
  current: string
  href: string
  label: string
}

type PageHeaderProps = {
  action?: ReactNode
  breadcrumb?: PageHeaderBreadcrumb
  description?: string
  title: string
}

export function PageHeader({ action, breadcrumb, description, title }: PageHeaderProps) {
  return (
    <header className="workflow-page-header">
      {breadcrumb && (
        <nav aria-label="Breadcrumb" className="workflow-breadcrumb">
          <ol>
            <li>
              <Link href={breadcrumb.href}>{breadcrumb.label}</Link>
            </li>
            <li aria-current="page">{breadcrumb.current}</li>
          </ol>
        </nav>
      )}

      <div className="workflow-page-header-row">
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {action && <div className="workflow-page-header-action">{action}</div>}
      </div>
    </header>
  )
}
