import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import { getBillingDefaultSettingsView } from '@/lib/billing/default-settings'
import { requireAppSession } from '@/lib/member-app/session'

import { BillingDefaultsForm } from './BillingDefaultsForm'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Invoice defaults | Project Time',
}

type SearchParams = {
  saved?: string | string[]
}

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')

  const [params, view] = await Promise.all([searchParams, getBillingDefaultSettingsView(session)])
  const lastSync = view.lastReferenceDataSyncAt
    ? new Intl.DateTimeFormat('en-NZ', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: session.user.timezone,
      }).format(new Date(view.lastReferenceDataSyncAt))
    : null
  const initialAccountCode = view.configuredAccountValid ? view.configuredAccountCode : ''
  const initialTaxType = view.configuredTaxValid ? view.configuredTaxType : ''

  return (
    <div className="narrow-page page-stack">
      <PageHeader
        action={
          <Link className="button button-secondary" href="/app/billing">
            Back to billing
          </Link>
        }
        breadcrumb={{ current: 'Invoice defaults', href: '/app/settings', label: 'Settings' }}
        description="Choose the account and tax type used for new Xero invoice previews. Existing export snapshots are unchanged."
        title="Invoice defaults"
      />

      {params.saved === '1' && (
        <div aria-live="polite" className="notice notice-success" role="status">
          Invoice defaults saved. <Link href="/app/billing">Return to billing</Link> to review the
          updated entries.
        </div>
      )}

      {!view.connected && (
        <div className="notice notice-warning" role="alert">
          Connect a Xero organisation before choosing invoice defaults.{' '}
          <Link href="/app/settings/xero">Open Xero settings</Link>.
        </div>
      )}

      {view.connected && (
        <section aria-label="Connected Xero organisation" className="panel page-stack">
          <div>
            <h2>{view.tenantName ?? 'Connected Xero organisation'}</h2>
            <p className="muted-copy">
              {lastSync
                ? `Accounts and tax rates last refreshed ${lastSync}.`
                : 'Accounts and tax rates have not been refreshed yet.'}
            </p>
          </div>
          <div>
            <Link className="button button-secondary" href="/app/settings/xero#reference-data">
              Open Xero refresh controls
            </Link>
          </div>
        </section>
      )}

      {view.connected && view.accountOptions.length === 0 && (
        <div className="notice notice-warning" role="alert">
          No active revenue accounts are available. Refresh Xero data, then check that the
          organisation has an active Revenue, Sales, or Other Income account.
        </div>
      )}
      {view.connected && view.taxRequired && view.taxOptions.length === 0 && (
        <div className="notice notice-warning" role="alert">
          No active revenue tax types are available. Refresh Xero data before saving invoice
          defaults.
        </div>
      )}
      {view.configuredAccountCode && !view.configuredAccountValid && (
        <div className="notice notice-warning" role="alert">
          The saved account “{view.configuredAccountCode}” is no longer an active Xero revenue
          account. Choose a replacement.
        </div>
      )}
      {view.configuredTaxType && !view.configuredTaxValid && (
        <div className="notice notice-warning" role="alert">
          The saved tax type “{view.configuredTaxType}” is no longer available for Xero revenue.
          Choose a replacement{view.taxRequired ? '.' : ' or clear it.'}
        </div>
      )}

      <BillingDefaultsForm
        accountOptions={view.accountOptions}
        initialAccountCode={initialAccountCode}
        initialTaxType={initialTaxType}
        taxOptions={view.taxOptions}
        taxRequired={view.taxRequired}
      />
    </div>
  )
}
