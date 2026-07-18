import { randomUUID } from 'node:crypto'

import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { createBillingPreview } from '@/lib/billing/reservation'
import { readSelectionToken } from '@/lib/billing/selection-token'
import { formatScaledAmount } from '@/lib/domain/money'
import { requireAppSession } from '@/lib/member-app/session'

import { confirmBillingExportAction } from '../actions'

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Invoice preview | Project Time' }

const duration = (seconds: number): string => {
  const minutes = seconds / 60
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export default async function BillingPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller'])) redirect('/app')
  const params = await searchParams
  const token = typeof params.selection === 'string' ? params.selection : ''
  let envelope
  try {
    envelope = readSelectionToken(token)
  } catch {
    redirect('/app/billing?status=invalid-selection')
  }
  const preview = await createBillingPreview(session, {
    batchReference: randomUUID().toUpperCase(),
    invoiceDate: envelope.invoiceDate,
    selection: envelope.selection,
  })
  const settings = await session.payload.findGlobal({
    slug: 'billing-settings',
    depth: 0,
    overrideAccess: true,
    req: session.req,
  })
  const configuredMode =
    settings.xeroExportMode === 'wait-for-result' ? 'wait-for-result' : 'background'
  const forcedBackground =
    preview.summary.invoiceCount > settings.maxWaitInvoices ||
    preview.summary.entryCount > settings.maxWaitLines ||
    settings.waitForResultEnabled !== true
  const canOverride = session.user.role !== 'biller' || settings.allowBillerModeOverride === true

  return (
    <div className="wide-page page-stack">
      <div className="breadcrumb">
        <Link href="/app/billing">Billing queue</Link>
        <span aria-hidden="true">/</span>
        <span>Preview</span>
      </div>
      <section className="page-heading compact">
        <div>
          <p className="eyebrow">Exact draft preview</p>
          <h1>
            Review {preview.invoices.length} Xero{' '}
            {preview.invoices.length === 1 ? 'invoice' : 'invoices'}
          </h1>
          <p>
            Every source entry remains a separate line. The server will rebuild and checksum this
            preview inside the reservation transaction.
          </p>
        </div>
      </section>
      {params.status && (
        <div className="notice notice-warning" role="alert">
          The previous confirmation was stale or could not be completed. This is a fresh preview;
          review every changed value before retrying.
        </div>
      )}
      {forcedBackground && (
        <div className="notice">
          This selection will run in the background because wait mode is disabled or its
          invoice/line threshold is exceeded.
        </div>
      )}
      {settings.acceptingNewExports !== true && (
        <div className="notice notice-warning">
          New exports are paused. You can review this preview, but confirmation is disabled.
        </div>
      )}

      <section className="summary-grid" aria-label="Preview summary">
        <article className="summary-card">
          <span>Entries</span>
          <strong>{preview.summary.entryCount}</strong>
          <small>{duration(preview.summary.durationSeconds)}</small>
        </article>
        <article className="summary-card">
          <span>Invoices</span>
          <strong>{preview.summary.invoiceCount}</strong>
          <small>{preview.summary.currencies.join(', ')}</small>
        </article>
        <article className="summary-card">
          <span>Application batch</span>
          <strong className="reference-copy">{preview.batchReference}</strong>
          <small>Stable reconciliation references below</small>
        </article>
      </section>

      {preview.invoices.map((invoice) => (
        <section className="panel page-stack invoice-preview" key={invoice.applicationReference}>
          <div className="invoice-header-grid">
            <div>
              <span>Customer / Xero contact</span>
              <strong>{invoice.contactName}</strong>
              <small>{invoice.contactID}</small>
            </div>
            <div>
              <span>Reference</span>
              <strong>{invoice.applicationReference}</strong>
              <small>ACCREC · DRAFT</small>
            </div>
            <div>
              <span>Dates</span>
              <strong>{invoice.invoiceDate}</strong>
              <small>Due {invoice.dueDate}</small>
            </div>
            <div>
              <span>Currency / amount type</span>
              <strong>{invoice.currency}</strong>
              <small>{preview.settings.lineAmountType}</small>
            </div>
          </div>
          <div className="table-wrap">
            <table className="time-table billing-table">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Invoice description</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Unit rate</th>
                  <th scope="col">Account / tax / tracking</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => (
                  <tr key={line.entryID}>
                    <td>
                      <Link href={`/app/time/${line.entryID}/edit`}>{line.workDate}</Link>
                      <small>
                        {line.userName} · {line.projectCode}
                      </small>
                    </td>
                    <td className="billing-description">{line.lineDescription}</td>
                    <td>
                      {(line.quantityScaled / 10_000).toFixed(4)} h
                      <small>{duration(line.durationSeconds)}</small>
                    </td>
                    <td>{formatScaledAmount(line.rateScaled, line.currency)}</td>
                    <td>
                      <strong>
                        {line.accountCode} · {line.taxType}
                      </strong>
                      <small>
                        {line.tracking.length > 0
                          ? line.tracking.map((item) => `${item.name}: ${item.option}`).join(', ')
                          : 'No tracking'}
                      </small>
                    </td>
                    <td>
                      <strong>{formatScaledAmount(line.amountScaled, line.currency)}</strong>
                      <small>Tax {formatScaledAmount(line.taxScaled, line.currency)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="invoice-totals">
            <div>
              <dt>Subtotal</dt>
              <dd>{formatScaledAmount(invoice.subtotalScaled, invoice.currency)}</dd>
            </div>
            <div>
              <dt>Tax</dt>
              <dd>{formatScaledAmount(invoice.taxScaled, invoice.currency)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{formatScaledAmount(invoice.totalScaled, invoice.currency)}</dd>
            </div>
          </dl>
        </section>
      ))}

      <form action={confirmBillingExportAction} className="panel entry-form confirmation-panel">
        <input name="batchReference" type="hidden" value={preview.batchReference} />
        <input name="checksum" type="hidden" value={preview.checksum} />
        <input name="selectionToken" type="hidden" value={token} />
        <div>
          <h2>Confirm and reserve</h2>
          <p>
            Confirmation atomically reserves all lines, saves immutable snapshots, and creates one
            durable job for each invoice.
          </p>
        </div>
        <label className="field">
          <span>Execution mode</span>
          <select
            defaultValue={forcedBackground ? 'background' : configuredMode}
            disabled={!canOverride || forcedBackground}
            name="requestedMode"
          >
            <option value="background">Background</option>
            <option value="wait-for-result">Wait briefly for Xero</option>
          </select>
          {(!canOverride || forcedBackground) && (
            <input
              name="requestedMode"
              type="hidden"
              value={forcedBackground ? 'background' : configuredMode}
            />
          )}
        </label>
        {canOverride && (
          <label className="field">
            <span>Override reason (required only when changing the configured mode)</span>
            <input maxLength={500} minLength={10} name="modeOverrideReason" />
          </label>
        )}
        <label className="confirmation-field">
          <input name="confirmed" required type="checkbox" value="yes" />
          <span>
            I reviewed every invoice header, source entry, line description, quantity, rate,
            account, tax, tracking value, and total.
          </span>
        </label>
        <div className="filter-actions">
          <Link className="button button-secondary" href="/app/billing">
            Cancel preview
          </Link>
          <button
            className="button button-primary"
            disabled={settings.acceptingNewExports !== true}
            type="submit"
          >
            Reserve and export
          </button>
        </div>
      </form>
    </div>
  )
}
