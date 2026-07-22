import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { PendingSubmitButton } from '@/app/(frontend)/_components/PendingControls'
import { exportStateLabel } from '@/lib/billing/export-presentation'
import { formatScaledAmount } from '@/lib/domain/money'
import { relationshipID } from '@/lib/domain/validation'
import { requireAppSession } from '@/lib/member-app/session'

import { runXeroQueueNowAction } from '../actions'

import type { Metadata } from 'next'
import type { Where } from 'payload'

export const metadata: Metadata = { title: 'Export history | Project Time' }

const duration = (seconds: number): string => {
  const minutes = seconds / 60
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export default async function ExportHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller'])) redirect('/app')
  const params = await searchParams
  const batch =
    typeof params.batch === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(params.batch)
      ? params.batch
      : undefined
  const includeReleased = params.released === 'include'
  const clauses: Where[] = []
  if (batch) clauses.push({ batch: { equals: batch } })
  // Keep deleted/voided exports visible until their entries have actually been
  // released. Those records still need user action even though Xero is finished.
  if (!includeReleased) clauses.push({ state: { not_equals: 'released' } })
  const where =
    clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : { and: clauses }
  const releasedToggleParams = new URLSearchParams()
  if (batch) releasedToggleParams.set('batch', batch)
  if (!includeReleased) releasedToggleParams.set('released', 'include')
  const releasedToggleQuery = releasedToggleParams.toString()
  const releasedToggleHref = `/app/billing/exports${releasedToggleQuery ? `?${releasedToggleQuery}` : ''}`
  const exports = await session.payload.find({
    collection: 'invoice-exports',
    depth: 1,
    limit: 100,
    overrideAccess: true,
    req: session.req,
    sort: '-createdAt',
    where,
  })
  const customerIDs = [
    ...new Set(
      exports.docs
        .map((item) => relationshipID(item.customer))
        .filter((id): id is number | string => id !== null),
    ),
  ]
  const customers =
    customerIDs.length === 0
      ? { docs: [] }
      : await session.payload.find({
          collection: 'customers',
          depth: 0,
          limit: customerIDs.length,
          overrideAccess: true,
          pagination: false,
          req: session.req,
          where: { id: { in: customerIDs } },
        })
  const customerNames = new Map(customers.docs.map((item) => [String(item.id), item.name]))
  return (
    <div className="wide-page page-stack">
      <div className="breadcrumb">
        <Link href="/app/billing">Billing queue</Link>
        <span aria-hidden="true">/</span>
        <span>Export history</span>
      </div>
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Durable exports</p>
          <h1>{batch ? 'Export batch' : 'Export history'}</h1>
          <p>Invoice Export state—not the job runner—is the source of billing truth.</p>
        </div>
        <div className="button-row">
          <Link className="button button-secondary" href={releasedToggleHref}>
            {includeReleased ? 'Hide released exports' : 'Show released exports'}
          </Link>
          {hasActiveRole(session.user, ['owner', 'admin']) && (
            <form action={runXeroQueueNowAction}>
              <PendingSubmitButton
                className="button button-secondary"
                pendingLabel="Running queue…"
              >
                Run Xero queue now
              </PendingSubmitButton>
            </form>
          )}
        </div>
      </section>
      {params.status && (
        <div
          className={
            String(params.status).includes('failed')
              ? 'notice notice-warning'
              : 'notice notice-success'
          }
          role="status"
        >
          {params.status === 'created'
            ? 'The entries are reserved and durable export jobs were created.'
            : params.status === 'queue-ran'
              ? 'The dispatcher and bounded Xero queue run completed.'
              : params.status === 'queue-failed'
                ? 'The queue run failed safely; durable work remains available for the next runner.'
                : 'Export history updated.'}
        </div>
      )}
      <section className="panel page-stack">
        <div className="table-wrap">
          <table className="time-table billing-table export-history-table">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Customer</th>
                <th scope="col">State</th>
                <th scope="col">Entries / duration</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {exports.docs.map((item) => {
                const customerID = relationshipID(item.customer)
                const customerName =
                  customerID === null ? undefined : customerNames.get(String(customerID))
                return (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/app/billing/exports/${item.id}`}>
                        {item.applicationReference}
                      </Link>
                      <small>{new Date(item.createdAt).toLocaleString('en-NZ')}</small>
                    </td>
                    <td>{customerName ?? `Customer ${customerID ?? 'unavailable'}`}</td>
                    <td>
                      <span className={`status-pill status-export-${item.state}`}>
                        {exportStateLabel(item.state)}
                      </span>
                      {item.lastErrorMessage && <small>{item.lastErrorMessage}</small>}
                    </td>
                    <td>
                      <strong>{item.entryCount}</strong>
                      <small>{duration(item.durationSeconds)}</small>
                    </td>
                    <td>{formatScaledAmount(item.totalScaled, item.currency)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {exports.docs.length === 0 && <p className="muted-copy">No exports match this view.</p>}
      </section>
    </div>
  )
}
