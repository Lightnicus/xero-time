import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { ExportStatusPoller } from '@/app/(frontend)/_components/ExportStatusPoller'
import { exportDetailActionAvailability } from '@/lib/billing/export-detail'
import { normalizeBillingFilter } from '@/lib/billing/selection'
import { createSelectionToken } from '@/lib/billing/selection-token'
import { formatScaledAmount } from '@/lib/domain/money'
import { formatCalendarDateInTimezone, relationshipID } from '@/lib/domain/validation'
import { requireAppSession } from '@/lib/member-app/session'

import {
  authorizeReplacementAction,
  cancelExportAction,
  deleteDraftAndReleaseExportAction,
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
  const commandStatus = Array.isArray(query.status) ? query.status[0] : query.status
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
  const actionAvailability = exportDetailActionAvailability(document, session.user.role)
  const xeroInvoiceHref =
    document.xeroInvoiceUrl ??
    (document.xeroInvoiceId
      ? `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(document.xeroInvoiceId)}`
      : null)
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
          <p>Review what was sent to Xero, its current status, and any action needed.</p>
        </div>
        <span className={`status-pill status-export-${document.state}`}>{document.state}</span>
      </section>
      {commandStatus && (
        <div
          className={
            commandStatus.includes('failed') ? 'notice notice-warning' : 'notice notice-success'
          }
          role="status"
        >
          {commandStatus === 'draft-deleted-and-released'
            ? 'The Xero draft was deleted and all mapped time entries were returned to unbilled.'
            : commandStatus === 'draft-delete-release-failed'
              ? 'The delete-and-release command did not complete. Time remains locked unless Xero deletion and the local release were both verified; refresh from Xero and retry safely.'
              : commandStatus === 'reconciling'
                ? 'Project Time is checking Xero again. This page will refresh automatically.'
                : commandStatus === 'refreshed'
                  ? 'The invoice status was refreshed from Xero.'
                  : commandStatus.includes('failed')
                    ? 'The command was blocked or failed safely. Review the current state and guidance before retrying.'
                    : `Export ${commandStatus}.`}
        </div>
      )}
      {document.lastErrorMessage && (
        <div className="notice notice-warning">
          <strong>{document.state === 'manual-review' ? 'Review needed' : 'Action needed'}</strong>
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
            {xeroInvoiceHref && (
              <a href={xeroInvoiceHref} rel="noreferrer" target="_blank">
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
          <p>These time entries and amounts were included in the Xero invoice.</p>
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

      {actionAvailability.canRefresh && (
        <section className="panel page-stack">
          <h2>Refresh invoice status</h2>
          <p>
            Check the saved invoice in Xero and update the status shown here. This does not create
            an invoice or release any time.
          </p>
          <form action={refreshExportAction}>
            <input name="exportID" type="hidden" value={id} />
            <button className="button button-secondary" type="submit">
              Refresh from Xero
            </button>
          </form>
        </section>
      )}

      {actionAvailability.showDraftRecovery && (
        <section className="panel page-stack">
          <div>
            <h2>Delete Xero draft and release time</h2>
            <p>
              Delete this draft in Xero and return all {document.entryCount} mapped time entries to
              the billing queue. Project Time checks the saved invoice again before changing
              anything and never deletes an authorised invoice.
            </p>
          </div>
          {actionAvailability.canDeleteDraft ? (
            <form action={deleteDraftAndReleaseExportAction} className="entry-form">
              <input name="exportID" type="hidden" value={id} />
              <label className="field">
                <span>Reason for deleting this draft</span>
                <textarea maxLength={1_000} minLength={10} name="reason" required />
              </label>
              <label className="field">
                <span>Type {document.applicationReference} to confirm</span>
                <input name="confirmation" required />
              </label>
              <button className="button button-danger" type="submit">
                Delete Xero draft and release time
              </button>
            </form>
          ) : (
            <div className="notice notice-warning">
              <strong>Draft deletion is not available yet.</strong>
              <p>
                Xero reports a draft, but Project Time could not verify that it exactly matches this
                export. Review the draft in Xero, then check again. If you delete it in Xero,
                refresh the status here and Project Time will offer to release the time safely.
              </p>
              {xeroInvoiceHref && (
                <a href={xeroInvoiceHref} rel="noreferrer" target="_blank">
                  Open draft in Xero
                </a>
              )}
            </div>
          )}
        </section>
      )}

      {actionAvailability.recoveryInProgress && (
        <section className="panel page-stack">
          <h2>Checking Xero</h2>
          <p>
            Project Time is looking for invoice reference {document.applicationReference}. This page
            refreshes automatically. Do not create another invoice while this check runs.
          </p>
        </section>
      )}

      {actionAvailability.canRequestRecovery && (
        <section className="panel page-stack">
          <h2>Check Xero and resume export</h2>
          <p>
            Project Time will look for invoice reference {document.applicationReference}. If no
            invoice exists and it is safe to continue, the original export can resume without
            starting an unrelated replacement.
          </p>
          {document.lastErrorCode === 'multiple-invoice-matches' && (
            <div className="notice notice-warning">
              More than one Xero invoice matches this reference. Resolve the duplicates in Xero,
              then check again here.
            </div>
          )}
          <form action={reconcileExportAction} className="entry-form">
            <input name="exportID" type="hidden" value={id} />
            <label className="field">
              <span>Reason for checking again</span>
              <textarea maxLength={1_000} minLength={10} name="reason" required />
            </label>
            <button className="button button-secondary" type="submit">
              Check Xero again
            </button>
          </form>
        </section>
      )}

      {actionAvailability.canAuthorizeReplacement && (
        <section className="panel page-stack">
          <h2>Create a replacement draft</h2>
          <p>
            Project Time could not find an invoice after the original safe retry period. Check Xero
            for reference {document.applicationReference} first. This action then starts a linked
            replacement without changing the original export history.
          </p>
          <form action={authorizeReplacementAction} className="entry-form">
            <input name="exportID" type="hidden" value={id} />
            <label className="field">
              <span>Reason for creating a replacement</span>
              <textarea maxLength={1_000} minLength={10} name="reason" required />
            </label>
            <label className="field">
              <span>Type {document.applicationReference} to confirm</span>
              <input name="confirmation" required />
            </label>
            <button className="button button-danger" type="submit">
              Create replacement draft
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

      <details className="panel export-technical-history">
        <summary>Technical history</summary>
        <div className="export-technical-history-content">
          <p>Recorded status changes for support and audit review.</p>
          <pre className="diagnostic-json">{JSON.stringify(document.stateHistory, null, 2)}</pre>
        </div>
      </details>
    </div>
  )
}
