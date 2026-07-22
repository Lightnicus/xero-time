import { cookies } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import {
  PendingNavigationForm,
  PendingSubmitButton,
} from '@/app/(frontend)/_components/PendingControls'
import { requireAppSession } from '@/lib/member-app/session'
import {
  ACCOUNTING_FLOW_COOKIE,
  getAccountingTenantSelection,
  type TenantSelection,
} from '@/lib/xero/accounting/service'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Select Xero organisation | Project Time',
}

export default async function SelectXeroTenantPage({
  searchParams,
}: {
  searchParams: Promise<{ flow?: string | string[] }>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin'])) redirect('/app')

  const params = await searchParams
  const flowID = typeof params.flow === 'string' ? params.flow : ''
  const browserBinding = (await cookies()).get(ACCOUNTING_FLOW_COOKIE)?.value ?? ''
  let selection: TenantSelection

  try {
    selection = await getAccountingTenantSelection(session, flowID, browserBinding)
  } catch {
    redirect('/app/settings/xero?error=invalid-state')
  }

  return (
    <div className="narrow-page page-stack">
      <PageHeader
        breadcrumb={{
          current: 'Select organisation',
          href: '/app/settings/xero',
          label: 'Xero accounting',
        }}
        description="Xero returned more than one organisation for this authorization. Choose the single business organisation this application must pin."
        title="Select Xero organisation"
      />

      <PendingNavigationForm
        action="/api/integrations/xero/accounting/select"
        className="form-section tenant-selection-form"
        method="post"
      >
        <input name="flowID" type="hidden" value={selection.flowID} />
        <fieldset className="tenant-options">
          <legend>Authorized organisations</legend>
          {selection.connections.map((connection) => (
            <label className="tenant-option" key={connection.connectionId}>
              <input name="tenantID" required type="radio" value={connection.tenantId} />
              <span>
                <strong>{connection.tenantName}</strong>
                <small>{connection.tenantId}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="notice notice-warning">
          The tenant ID becomes a permanent safety boundary. Switching organisations later requires
          a separately planned migration.
        </div>
        <div className="form-actions">
          <Link className="button button-secondary" href="/app/settings/xero">
            Cancel
          </Link>
          <PendingSubmitButton
            className="button button-primary"
            pendingLabel="Pinning organisation…"
          >
            Pin this organisation
          </PendingSubmitButton>
        </div>
      </PendingNavigationForm>
    </div>
  )
}
