import { randomUUID } from 'node:crypto'

import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { MetricStrip } from '@/app/(frontend)/_components/MetricStrip'
import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import { PendingSubmitButton } from '@/app/(frontend)/_components/PendingControls'
import { createBillingPreview } from '@/lib/billing/reservation'
import { readSelectionToken } from '@/lib/billing/selection-token'
import { formatScaledAmount } from '@/lib/domain/money'
import { requireAppSession } from '@/lib/member-app/session'

import { confirmBillingExportAction } from '../actions'

import type { Metadata } from 'next'

import '../../../billing-workflow.css'

export const metadata: Metadata = { title: 'Invoice preview | Project Time' }

const duration = (seconds: number): string => {
  const minutes = seconds / 60
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const currencyTotalsLabel = (totals: Map<string, number>): string =>
  [...totals]
    .map(([currency, amountScaled]) => formatScaledAmount(amountScaled, currency))
    .join(' · ')

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
  const customerCount = new Set(preview.invoices.map((invoice) => invoice.contactID)).size
  const invoiceDates = new Set(preview.invoices.map((invoice) => invoice.invoiceDate))
  const dueDates = new Set(preview.invoices.map((invoice) => invoice.dueDate))
  const subtotalByCurrency = new Map<string, number>()
  const taxByCurrency = new Map<string, number>()
  const totalByCurrency = new Map<string, number>()
  for (const invoice of preview.invoices) {
    subtotalByCurrency.set(
      invoice.currency,
      (subtotalByCurrency.get(invoice.currency) ?? 0) + invoice.subtotalScaled,
    )
    taxByCurrency.set(
      invoice.currency,
      (taxByCurrency.get(invoice.currency) ?? 0) + invoice.taxScaled,
    )
    totalByCurrency.set(
      invoice.currency,
      (totalByCurrency.get(invoice.currency) ?? 0) + invoice.totalScaled,
    )
  }
  const invoiceDateLabel =
    invoiceDates.size === 1
      ? ([...invoiceDates][0] as string)
      : `${invoiceDates.size} invoice dates`
  const dueDateLabel =
    dueDates.size === 1 ? ([...dueDates][0] as string) : `${dueDates.size} due dates`

  return (
    <div className="wide-page page-stack billing-workflow-page">
      <PageHeader
        breadcrumb={{ current: 'Review drafts', href: '/app/billing', label: 'Billing queue' }}
        description="Check customers, line items, dates and totals. Nothing is created until you confirm below."
        title={`Review ${preview.invoices.length} draft ${
          preview.invoices.length === 1 ? 'invoice' : 'invoices'
        }`}
      />
      {params.status && (
        <div className="notice notice-warning" role="alert">
          The previous confirmation was stale or could not be completed. This is a fresh preview;
          review every changed value before retrying.
        </div>
      )}
      {forcedBackground && (
        <div className="notice">
          Xero submission will continue in the background because this selection exceeds the
          configured wait limit or wait mode is off.
        </div>
      )}
      {settings.acceptingNewExports !== true && (
        <div className="notice notice-warning">
          New exports are paused. You can review this preview, but confirmation is disabled.
        </div>
      )}

      <MetricStrip
        label="Preview summary"
        metrics={[
          {
            label: 'Draft invoices',
            value: `${preview.summary.invoiceCount} · ${customerCount} ${customerCount === 1 ? 'customer' : 'customers'}`,
          },
          {
            label: 'Line items',
            value: `${preview.summary.entryCount} · ${duration(preview.summary.durationSeconds)}`,
          },
          { label: 'Dates', value: `${invoiceDateLabel} · due ${dueDateLabel}` },
        ]}
      />
      <MetricStrip
        label="Preview values"
        metrics={[
          { label: 'Pre-tax', value: currencyTotalsLabel(subtotalByCurrency) },
          { label: 'Tax', value: currencyTotalsLabel(taxByCurrency) },
          { label: 'Total', value: currencyTotalsLabel(totalByCurrency) },
        ]}
      />

      {preview.invoices.map((invoice) => (
        <section
          className="billing-invoice-preview"
          key={invoice.applicationReference}
          aria-labelledby={`invoice-${invoice.applicationReference}`}
        >
          <div className="billing-invoice-heading">
            <div>
              <span>Draft invoice</span>
              <h2 id={`invoice-${invoice.applicationReference}`}>{invoice.contactName}</h2>
            </div>
            <strong>{invoice.applicationReference}</strong>
          </div>
          <dl className="billing-invoice-facts">
            <div>
              <dt>Invoice date</dt>
              <dd>{invoice.invoiceDate}</dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>{invoice.dueDate}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{invoice.currency}</dd>
            </div>
            <div>
              <dt>Contact</dt>
              <dd>{invoice.contactID}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>ACCREC · DRAFT · {preview.settings.lineAmountType}</dd>
            </div>
          </dl>
          <div className="billing-preview-table-shell">
            <table className="billing-workflow-table billing-preview-table">
              <caption className="visually-hidden">
                Draft invoice lines for {invoice.contactName}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Invoice description</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Unit rate</th>
                  <th scope="col">Item / account / tax / tracking</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => (
                  <tr key={line.entryID}>
                    <td>
                      <span className="billing-mobile-label">Source</span>
                      <Link href={`/app/time/${line.entryID}/edit`}>{line.workDate}</Link>
                      <small>
                        {line.userName} · {line.projectCode}
                      </small>
                    </td>
                    <td className="billing-workflow-description">
                      <span className="billing-mobile-label">Invoice description</span>
                      {line.lineDescription}
                    </td>
                    <td>
                      <span className="billing-mobile-label">Quantity</span>
                      {(line.quantityScaled / 10_000).toFixed(4)} h
                      <small>{duration(line.durationSeconds)}</small>
                    </td>
                    <td>
                      <span className="billing-mobile-label">Unit rate</span>
                      {formatScaledAmount(line.rateScaled, line.currency)}
                    </td>
                    <td>
                      <span className="billing-mobile-label">Xero coding</span>
                      <strong>
                        {line.itemCode} — {line.itemName}
                      </strong>
                      <small>
                        {line.accountCode} · {line.taxType}
                      </small>
                      <small>
                        {line.tracking.length > 0
                          ? line.tracking.map((item) => `${item.name}: ${item.option}`).join(', ')
                          : 'No tracking'}
                      </small>
                    </td>
                    <td>
                      <span className="billing-mobile-label">Amount</span>
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

      <form action={confirmBillingExportAction} className="billing-confirmation-panel">
        <input name="batchReference" type="hidden" value={preview.batchReference} />
        <input name="checksum" type="hidden" value={preview.checksum} />
        <input name="selectionToken" type="hidden" value={token} />
        <div>
          <h2>Create draft invoices</h2>
          <p>
            Confirmation reserves these time entries against duplicate billing and sends the draft
            invoices to Xero. Follow progress or recover a failed submission from Export history.
          </p>
        </div>
        <label className="confirmation-field">
          <input name="confirmed" required type="checkbox" value="yes" />
          <span>
            I reviewed every invoice header, source entry, line description, quantity, rate, item,
            account, tax, tracking value, and total.
          </span>
        </label>
        <details className="billing-safeguards">
          <summary>Technical safeguards and delivery</summary>
          <div className="billing-safeguards-content">
            <p>
              Before creating drafts, Project Time rechecks the source entries and totals, rejects
              stale changes, keeps every source entry as its own line, reserves each line once, and
              records each submission for recovery.
            </p>
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
          </div>
        </details>
        <div className="billing-confirmation-actions">
          <Link className="button button-secondary" href="/app/billing">
            Cancel preview
          </Link>
          <PendingSubmitButton
            className="button button-primary"
            disabled={settings.acceptingNewExports !== true}
            pendingLabel="Creating drafts…"
          >
            Create draft invoices
          </PendingSubmitButton>
        </div>
      </form>
    </div>
  )
}
