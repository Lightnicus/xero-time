import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { ExportStatusPoller } from '@/app/(frontend)/_components/ExportStatusPoller'
import { normalizeBillingFilter } from '@/lib/billing/selection'
import { createSelectionToken } from '@/lib/billing/selection-token'
import { formatScaledAmount } from '@/lib/domain/money'
import { formatCalendarDateInTimezone, relationshipID } from '@/lib/domain/validation'
import { requireAppSession } from '@/lib/member-app/session'

import {
  acceptExistingInvoiceAction,
  authorizeReplacementAction,
  cancelExportAction,
  reconcileExportAction,
  refreshExportAction,
  releaseExportAction,
} from '../../actions'

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Invoice export | Project Time' }

const activeStates = new Set(['preparing', 'queued', 'processing', 'retry-wait', 'reconciling'])

const duration = (seconds: number): string => {
  const minutes = seconds / 60
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export default async function InvoiceExportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller'])) redirect('/app')
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) notFound()
  let document
  try {
    document = await session.payload.findByID({
      collection: 'invoice-exports',
      id,
      depth: 1,
      overrideAccess: true,
      req: session.req,
    })
  } catch {
    notFound()
  }
  const query = await searchParams
  const allocations = await session.payload.find({
    collection: 'invoice-export-entries',
    depth: 0,
    limit: 1_000,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    sort: 'lineOrdinal',
    where: { invoiceExport: { equals: id } },
  })
  const isOwnerAdmin = hasActiveRole(session.user, ['owner', 'admin'])
  const entryIDs = allocations.docs
    .map((line) => String(relationshipID(line.timeEntry)))
    .filter(Boolean)
  const rebillToken =
    document.state === 'released'
      ? createSelectionToken({
          invoiceDate: formatCalendarDateInTimezone(new Date(), session.user.timezone),
          selection: {
            excludedEntryIDs: [],
            explicitEntryIDs: entryIDs,
            filter: normalizeBillingFilter({ timezone: session.user.timezone }),
            type: 'explicit',
          },
        })
      : null

  return (
    <div className="wide-page page-stack">
      <ExportStatusPoller active={activeStates.has(document.state)} />
      <div className="breadcrumb">
        <Link href="/app/billing/exports">Export history</Link>
        <span aria-hidden="true">/</span>
        <span>{document.applicationReference}</span>
      </div>
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Invoice export</p>
          <h1>{document.applicationReference}</h1>
          <p>Immutable request, line allocation, attempts, remote status, and release lineage.</p>
        </div>
        <span className={`status-pill status-export-${document.state}`}>{document.state}</span>
      </section>
      {query.status && (
        <div
          className={
            String(query.status).includes('failed')
              ? 'notice notice-warning'
              : 'notice notice-success'
          }
          role="status"
        >
          {String(query.status).includes('failed')
            ? 'The command was blocked or failed safely. Review the current state and guidance before retrying.'
            : `Export ${query.status}.`}
        </div>
      )}
      {document.lastErrorMessage && (
        <div className="notice notice-warning">
          <strong>{document.lastErrorCode}</strong>
          <p>{document.lastErrorMessage}</p>
        </div>
      )}

      <section className="summary-grid">
        <article className="summary-card">
          <span>Remote status</span>
          <strong>{document.remoteStatus ?? 'Not yet known'}</strong>
          <small>
            {document.lastReconciledAt
              ? `Checked ${new Date(document.lastReconciledAt).toLocaleString('en-NZ')}`
              : 'Not reconciled'}
          </small>
        </article>
        <article className="summary-card">
          <span>Entries</span>
          <strong>{document.entryCount}</strong>
          <small>{duration(document.durationSeconds)}</small>
        </article>
        <article className="summary-card">
          <span>Total</span>
          <strong>{formatScaledAmount(document.totalScaled, document.currency)}</strong>
          <small>
            Subtotal {formatScaledAmount(document.subtotalScaled, document.currency)} · tax{' '}
            {formatScaledAmount(document.taxScaled, document.currency)}
          </small>
        </article>
      </section>

      <section className="panel page-stack">
        <div className="invoice-header-grid">
          <div>
            <span>Xero invoice</span>
            <strong>{document.xeroInvoiceNumber ?? 'Not created'}</strong>
            {document.xeroInvoiceUrl && (
              <a href={document.xeroInvoiceUrl} rel="noreferrer" target="_blank">
                Open in Xero
              </a>
            )}
          </div>
          <div>
            <span>Dates</span>
            <strong>{document.invoiceDate.slice(0, 10)}</strong>
            <small>Due {document.dueDate.slice(0, 10)}</small>
          </div>
          <div>
            <span>Execution</span>
            <strong>{document.actualMode}</strong>
            <small>Requested {document.requestedMode}</small>
          </div>
          <div>
            <span>Attempt</span>
            <strong>{document.currentAttemptNumber}</strong>
            <small>Job {document.jobId ?? 'not attached'}</small>
          </div>
        </div>
        {document.rebillOf && (
          <p>
            Rebill of{' '}
            <Link href={`/app/billing/exports/${relationshipID(document.rebillOf)}`}>
              {String(relationshipID(document.rebillOf))}
            </Link>
            .
          </p>
        )}
        {document.releaseAction && (
          <p>
            Release action: <strong>{String(relationshipID(document.releaseAction))}</strong>.
          </p>
        )}
      </section>

      <section className="panel page-stack">
        <div>
          <h2>Mapped invoice lines</h2>
          <p>Each immutable allocation maps one source time entry to one Xero line ordinal.</p>
        </div>
        <div className="table-wrap">
          <table className="time-table billing-table">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Source</th>
                <th scope="col">Description</th>
                <th scope="col">Quantity / rate</th>
                <th scope="col">Item / account / tax</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {allocations.docs.map((line) => (
                <tr key={line.id}>
                  <td>
                    {line.lineOrdinal + 1}
                    <small>{line.xeroLineItemId ?? 'No LineItemID'}</small>
                  </td>
                  <td>
                    <Link href={`/app/time/${relationshipID(line.timeEntry)}/edit`}>
                      {line.workDate}
                    </Link>
                    <small>
                      {line.userName} · {line.projectCode}
                    </small>
                  </td>
                  <td className="billing-description">{line.description}</td>
                  <td>
                    {(line.quantityScaled / 10_000).toFixed(4)} h
                    <small>{formatScaledAmount(line.rateScaled, line.currency)}/h</small>
                  </td>
                  <td>
                    <strong>
                      {line.itemCode && line.itemName
                        ? `${line.itemCode} — ${line.itemName}`
                        : 'No item snapshot'}
                    </strong>
                    <small>
                      {line.accountCode} · {line.taxType}
                    </small>
                    {line.xeroItemId && <small>ItemID {line.xeroItemId}</small>}
                  </td>
                  <td>
                    {formatScaledAmount(line.amountScaled, line.currency)}
                    <small>Tax {formatScaledAmount(line.taxScaled, line.currency)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel page-stack">
        <div>
          <h2>State history</h2>
          <p>
            Committed transition metadata is retained without tokens or full provider responses.
          </p>
        </div>
        <pre className="diagnostic-json">{JSON.stringify(document.stateHistory, null, 2)}</pre>
      </section>

      {(document.state === 'preparing' || document.state === 'queued') && (
        <section className="panel page-stack">
          <h2>Cancel before send</h2>
          <p>
            Cancellation is accepted only if the immutable attempt proves no request has started.
            Reservations are released atomically.
          </p>
          <form action={cancelExportAction} className="entry-form">
            <input name="exportID" type="hidden" value={id} />
            <label className="field">
              <span>Reason</span>
              <textarea maxLength={1_000} minLength={10} name="reason" required />
            </label>
            <button className="button button-danger" type="submit">
              Cancel export
            </button>
          </form>
        </section>
      )}

      {isOwnerAdmin && document.xeroInvoiceId && (
        <section className="panel page-stack">
          <h2>Authoritative Xero refresh</h2>
          <p>
            Fetch the invoice by saved InvoiceID, compare material lines, and update local remote
            status. This never releases time automatically.
          </p>
          <form action={refreshExportAction}>
            <input name="exportID" type="hidden" value={id} />
            <button className="button button-secondary" type="submit">
              Refresh from Xero
            </button>
          </form>
        </section>
      )}

      {isOwnerAdmin &&
        ['action-required', 'manual-review', 'reconciling'].includes(document.state) && (
          <section className="panel page-stack">
            <h2>Targeted reconciliation</h2>
            <p>
              Run the same targeted read service used for ambiguous outcomes. There is no generic
              mark-succeeded control.
            </p>
            <form action={reconcileExportAction} className="entry-form">
              <input name="exportID" type="hidden" value={id} />
              <label className="field">
                <span>Reason</span>
                <textarea maxLength={1_000} minLength={10} name="reason" required />
              </label>
              <button className="button button-secondary" type="submit">
                Queue reconciliation
              </button>
            </form>
          </section>
        )}

      {isOwnerAdmin && document.state === 'manual-review' && (
        <section className="panel page-stack">
          <h2>Accept one verified existing invoice</h2>
          <p>
            The InvoiceID is fetched and every material value must exactly match the immutable
            snapshot.
          </p>
          <form action={acceptExistingInvoiceAction} className="entry-form">
            <input name="exportID" type="hidden" value={id} />
            <label className="field">
              <span>Xero InvoiceID</span>
              <input name="invoiceID" pattern="[0-9a-fA-F-]{36}" required />
            </label>
            <label className="field">
              <span>Reason</span>
              <textarea maxLength={1_000} minLength={10} name="reason" required />
            </label>
            <button className="button button-secondary" type="submit">
              Verify and accept invoice
            </button>
          </form>
        </section>
      )}

      {isOwnerAdmin &&
        document.lastErrorCode === 'confirmed-absent-replacement-approval-required' && (
          <section className="panel page-stack">
            <h2>Authorize linked replacement attempt</h2>
            <p>
              A targeted read confirmed absence after the original idempotency window. This creates
              a new immutable attempt and key linked to the original.
            </p>
            <form action={authorizeReplacementAction} className="entry-form">
              <input name="exportID" type="hidden" value={id} />
              <label className="field">
                <span>Reason</span>
                <textarea maxLength={1_000} minLength={10} name="reason" required />
              </label>
              <label className="field">
                <span>Type {document.applicationReference}</span>
                <input name="confirmation" required />
              </label>
              <button className="button button-danger" type="submit">
                Authorize replacement POST
              </button>
            </form>
          </section>
        )}

      {isOwnerAdmin &&
        (document.remoteStatus === 'DELETED' || document.remoteStatus === 'VOIDED') &&
        document.state !== 'released' && (
          <section className="panel page-stack">
            <h2>Release all entries for rebilling</h2>
            <p>
              This command immediately re-fetches Xero, requires DELETED or VOIDED, and returns all{' '}
              {document.entryCount} mapped entries to unbilled in one transaction.
            </p>
            <form action={releaseExportAction} className="entry-form">
              <input name="exportID" type="hidden" value={id} />
              <label className="field">
                <span>Reason</span>
                <textarea maxLength={1_000} minLength={10} name="reason" required />
              </label>
              <label className="field">
                <span>Type {document.applicationReference}</span>
                <input name="confirmation" required />
              </label>
              <button className="button button-danger" type="submit">
                Verify and release all entries
              </button>
            </form>
          </section>
        )}

      {rebillToken && (
        <section className="panel page-stack">
          <h2>Rebill released entries</h2>
          <p>
            The replacement follows ordinary eligibility, preview, reservation, and job processing.
            Original snapshots remain unchanged.
          </p>
          <Link
            className="button button-primary"
            href={`/app/billing/preview?selection=${encodeURIComponent(rebillToken)}`}
          >
            Open rebill preview
          </Link>
        </section>
      )}
    </div>
  )
}
