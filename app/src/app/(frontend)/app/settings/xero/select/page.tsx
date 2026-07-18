import { cookies } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
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
      <div className="breadcrumb">
        <Link href="/app/settings/xero">Xero accounting</Link>
        <span aria-hidden="true">/</span>
        <span>Select organisation</span>
      </div>

      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Explicit tenant selection</p>
          <h1>Select Xero organisation</h1>
          <p>
            Xero returned more than one organisation for this authorization. Choose the single
            business organisation this application must pin.
          </p>
        </div>
      </section>

      <form
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
          <button className="button button-primary" type="submit">
            Pin this organisation
          </button>
        </div>
      </form>
    </div>
  )
}
