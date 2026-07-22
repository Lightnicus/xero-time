import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import { requireAppSession } from '@/lib/member-app/session'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Settings | Project Time',
}

const workflowLinks = [
  {
    description: 'Invite teammates and review invitation history.',
    href: '/app/settings/users',
    label: 'People & invitations',
  },
  {
    description: 'Set invoice references and map customers to Xero contacts.',
    href: '/app/settings/customers',
    label: 'Customer billing',
  },
  {
    description: 'Set project rates and map projects to Xero invoice items.',
    href: '/app/settings/projects',
    label: 'Project billing',
  },
  {
    description: 'Choose the account and tax type used for new invoice previews.',
    href: '/app/settings/billing',
    label: 'Invoice defaults',
  },
  {
    description: 'Connect the organisation used for Xero billing and exports.',
    href: '/app/settings/xero',
    label: 'Xero accounting',
  },
]

const advancedLinks = [
  {
    description: 'Review integration health, audit history, and system diagnostics.',
    href: '/app/operations',
    label: 'Operations',
    leavesApp: false,
  },
  {
    description: 'Manage underlying records and advanced application configuration.',
    href: '/admin',
    label: 'Payload Admin',
    leavesApp: true,
  },
]

export default async function SettingsPage() {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')

  return (
    <div className="wide-page page-stack settings-overview">
      <PageHeader
        description="Manage the people, billing rules, and accounting connection for this business."
        title="Settings"
      />

      <section className="settings-link-section" aria-labelledby="settings-workflows-heading">
        <div className="settings-section-heading">
          <h2 id="settings-workflows-heading">Business workflows</h2>
          <p>Configuration used in day-to-day time billing.</p>
        </div>
        <div className="settings-link-list">
          {workflowLinks.map((item) => (
            <Link href={item.href} key={item.href}>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <span aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </section>

      <section
        className="settings-link-section settings-link-section-advanced"
        aria-labelledby="settings-advanced-heading"
      >
        <div className="settings-section-heading">
          <h2 id="settings-advanced-heading">Advanced administration</h2>
          <p>Diagnostics and direct record administration for occasional use.</p>
        </div>
        <div className="settings-link-list">
          {advancedLinks.map((item) => (
            <Link
              aria-label={
                item.leavesApp ? `${item.label}, opens advanced administration` : undefined
              }
              href={item.href}
              key={item.href}
            >
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <span aria-hidden="true">{item.leavesApp ? '↗' : '→'}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
