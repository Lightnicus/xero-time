import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { BillingSelectionToolbar } from '@/app/(frontend)/_components/BillingSelectionToolbar'
import { BILLING_BLOCKER_CODES, type BillingFilter } from '@/lib/billing/contracts'
import { getBillingEligibility } from '@/lib/billing/eligibility'
import {
  billingBlockerActionLabel,
  billingBlockerLabel,
  summarizeBillingRemediation,
} from '@/lib/billing/remediation'
import { summarizeSelection } from '@/lib/billing/selection'
import { formatScaledAmount } from '@/lib/domain/money'
import { formatCalendarDateInTimezone } from '@/lib/domain/validation'
import { requireAppSession } from '@/lib/member-app/session'

import {
  allUninvoicedPreviewAction,
  refreshBillingReferenceDataAction,
  startBillingPreviewAction,
} from './actions'

import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Billing queue | Project Time' }

type Params = Record<string, string | string[] | undefined>

const param = (params: Params, name: string): string =>
  typeof params[name] === 'string' ? params[name] : ''

const duration = (seconds: number): string => {
  const minutes = seconds / 60
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const statusNotice = (status: string): { message: string; tone: 'success' | 'warning' } | null => {
  if (status === 'invalid-selection') {
    return {
      message: 'Select at least one eligible entry, or choose all matching.',
      tone: 'warning',
    }
  }
  if (status === 'references-refreshed') {
    return {
      message: 'Xero accounts, tax types, currencies, and invoice permissions were refreshed.',
      tone: 'success',
    }
  }
  if (status === 'xero-capability-missing') {
    return {
      message:
        'Xero data was refreshed, but this organisation still did not report permission to create draft invoices.',
      tone: 'warning',
    }
  }
  if (status === 'reference-refresh-failed') {
    return {
      message: 'Xero data could not be refreshed. Check the connection and try again.',
      tone: 'warning',
    }
  }
  if (status) {
    return {
      message: 'The billing queue could not be loaded. Narrow the filters and retry.',
      tone: 'warning',
    }
  }
  return null
}

const hiddenFilter = (filter: BillingFilter) => (
  <>
    <input name="blocker" type="hidden" value={filter.blocker ?? ''} />
    <input name="currency" type="hidden" value={filter.currency ?? ''} />
    <input name="customerID" type="hidden" value={filter.customerID ?? ''} />
    <input name="dateFrom" type="hidden" value={filter.dateFrom ?? ''} />
    <input name="dateTo" type="hidden" value={filter.dateTo ?? ''} />
    <input name="projectID" type="hidden" value={filter.projectID ?? ''} />
    <input name="timezone" type="hidden" value={filter.timezone} />
    <input name="userID" type="hidden" value={filter.userID ?? ''} />
  </>
)

export default async function BillingQueuePage({
  searchParams,
}: {
  searchParams: Promise<Params>
}) {
  const session = await requireAppSession()
  if (!hasActiveRole(session.user, ['owner', 'admin', 'biller'])) redirect('/app')
  const params = await searchParams
  const filter: Partial<BillingFilter> = {
    blocker: param(params, 'blocker') as BillingFilter['blocker'],
    currency: param(params, 'currency'),
    customerID: param(params, 'customerID'),
    dateFrom: param(params, 'dateFrom'),
    dateTo: param(params, 'dateTo'),
    projectID: param(params, 'projectID'),
    timezone: session.user.timezone,
    userID: param(params, 'userID'),
  }
  const eligibility = await getBillingEligibility(session, filter)
  const canManageBillingSetup = hasActiveRole(session.user, ['owner', 'admin'])
  const remediation = summarizeBillingRemediation(eligibility.blocked)
  const [customers, projects, users] = await Promise.all([
    session.payload.find({
      collection: 'customers',
      depth: 0,
      limit: 500,
      overrideAccess: true,
      pagination: false,
      req: session.req,
      sort: 'name',
    }),
    session.payload.find({
      collection: 'projects',
      depth: 0,
      limit: 500,
      overrideAccess: true,
      pagination: false,
      req: session.req,
      sort: 'code',
    }),
    session.payload.find({
      collection: 'users',
      depth: 0,
      limit: 500,
      overrideAccess: true,
      pagination: false,
      req: session.req,
      sort: 'displayName',
      where: { active: { equals: true } },
    }),
  ])
  const summary = summarizeSelection(eligibility.eligible)
  const visibleEligible = eligibility.eligible.slice(0, 500)
  const currencyAmounts = new Map<string, number>()
  const groupCounts = new Map<string, number>()
  for (const entry of eligibility.eligible) {
    currencyAmounts.set(
      entry.currency,
      (currencyAmounts.get(entry.currency) ?? 0) + entry.amountScaled,
    )
    const groupKey = `${entry.contactID}:${entry.currency}`
    groupCounts.set(groupKey, (groupCounts.get(groupKey) ?? 0) + 1)
  }
  const invoiceDate = formatCalendarDateInTimezone(new Date(), session.user.timezone)
  const normalizedFilter = {
    blocker: filter.blocker || undefined,
    currency: filter.currency || undefined,
    customerID: filter.customerID || undefined,
    dateFrom: filter.dateFrom || undefined,
    dateTo: filter.dateTo || undefined,
    projectID: filter.projectID || undefined,
    timezone: session.user.timezone,
    userID: filter.userID || undefined,
  } satisfies BillingFilter
  const notice = statusNotice(param(params, 'status'))

  return (
    <div className="wide-page page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Invoicing</p>
          <h1>Billing queue</h1>
          <p>
            Review complete time-entry lines, resolve blockers, and preview the exact Xero drafts
            before reserving anything.
          </p>
        </div>
        <Link className="button button-secondary" href="/app/billing/exports">
          Export history
        </Link>
      </section>

      {notice && (
        <div
          className={`notice notice-${notice.tone}`}
          role={notice.tone === 'success' ? 'status' : 'alert'}
        >
          {notice.message}
        </div>
      )}
      {eligibility.settingsDocument.acceptingNewExports !== true && (
        <div className="notice notice-warning">
          New Xero exports are currently paused. Invoice previews remain available, but confirmation
          is disabled.{' '}
          {canManageBillingSetup ? (
            <Link href="/admin/globals/billing-settings">Manage the export switch</Link>
          ) : (
            'Ask an owner or administrator to enable new exports.'
          )}
        </div>
      )}

      {remediation.setupIssues.length > 0 && (
        <section
          aria-labelledby="billing-setup-heading"
          className="panel page-stack billing-setup-panel"
        >
          <div>
            <p className="eyebrow">Action required</p>
            <h2 id="billing-setup-heading">Finish billing setup</h2>
            <p>
              These organisation-level settings block invoice previews. Resolve each item once; the
              affected time entries do not need to be edited individually.
            </p>
          </div>
          <ul className="billing-setup-list">
            {remediation.setupIssues.map((issue) => (
              <li className="billing-setup-item" key={issue.code}>
                <div>
                  <h3>{issue.title}</h3>
                  <p>{issue.description}</p>
                  <small>
                    Blocking {issue.entryCount} {issue.entryCount === 1 ? 'entry' : 'entries'}
                  </small>
                </div>
                {canManageBillingSetup && issue.action === 'refresh-xero' && (
                  <form action={refreshBillingReferenceDataAction}>
                    <button className="button button-secondary" type="submit">
                      {issue.actionLabel}
                    </button>
                  </form>
                )}
                {canManageBillingSetup && issue.action === 'billing-settings' && (
                  <Link className="button button-secondary" href="/app/settings/billing">
                    {issue.actionLabel}
                  </Link>
                )}
                {canManageBillingSetup && issue.action === 'xero-settings' && (
                  <Link className="button button-secondary" href="/app/settings/xero">
                    {issue.actionLabel}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {!canManageBillingSetup && (
            <div className="notice notice-warning">
              Ask an owner or administrator to complete these billing setup steps.
            </div>
          )}
        </section>
      )}

      <section className="panel filter-panel" aria-label="Billing filters">
        <form className="filter-form" method="get">
          <div className="filter-grid">
            <label className="field">
              <span>From</span>
              <input defaultValue={param(params, 'dateFrom')} name="dateFrom" type="date" />
            </label>
            <label className="field">
              <span>To</span>
              <input defaultValue={param(params, 'dateTo')} name="dateTo" type="date" />
            </label>
            <label className="field">
              <span>Customer</span>
              <select defaultValue={param(params, 'customerID')} name="customerID">
                <option value="">All customers</option>
                {customers.docs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Project</span>
              <select defaultValue={param(params, 'projectID')} name="projectID">
                <option value="">All projects</option>
                {projects.docs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} — {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>User</span>
              <select defaultValue={param(params, 'userID')} name="userID">
                <option value="">All users</option>
                {users.docs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Currency</span>
              <input
                defaultValue={param(params, 'currency')}
                maxLength={3}
                name="currency"
                placeholder="NZD"
              />
            </label>
            <label className="field">
              <span>Blocker</span>
              <select defaultValue={param(params, 'blocker')} name="blocker">
                <option value="">All rows</option>
                {BILLING_BLOCKER_CODES.map((code) => (
                  <option key={code} value={code}>
                    {billingBlockerLabel(code)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="filter-actions">
            <Link className="button button-secondary" href="/app/billing">
              Clear filters
            </Link>
            <button className="button button-primary" type="submit">
              Apply filters
            </button>
          </div>
        </form>
      </section>

      <section className="summary-grid" aria-label="Eligible billing summary">
        <article className="summary-card">
          <span>Eligible entries</span>
          <strong>{summary.entryCount}</strong>
          <small>{duration(summary.durationSeconds)}</small>
        </article>
        <article className="summary-card">
          <span>Prospective invoices</span>
          <strong>{summary.invoiceCount}</strong>
          <small>Grouped only by contact and currency</small>
        </article>
        <article className="summary-card">
          <span>Pre-tax value</span>
          <strong>
            {summary.currencies.length === 1
              ? formatScaledAmount(summary.amountScaled, summary.currencies[0] as string)
              : `${summary.currencies.length} currencies`}
          </strong>
          <small>
            {summary.oldestWorkDate && summary.newestWorkDate
              ? `${summary.oldestWorkDate} – ${summary.newestWorkDate}`
              : 'No eligible dates'}
          </small>
        </article>
      </section>

      <form action={startBillingPreviewAction} className="panel page-stack">
        {hiddenFilter(normalizedFilter)}
        <label className="field billing-invoice-date">
          <span>Invoice date</span>
          <input defaultValue={invoiceDate} name="invoiceDate" required type="date" />
        </label>
        <div className="table-wrap">
          <table className="time-table billing-table">
            <thead>
              <tr>
                <th scope="col">Select</th>
                <th scope="col">Date / user</th>
                <th scope="col">Customer / project</th>
                <th scope="col">Description</th>
                <th scope="col">Time</th>
                <th scope="col">Rate / amount</th>
              </tr>
            </thead>
            <tbody>
              {visibleEligible.map((entry) => (
                <tr key={entry.entryID}>
                  <td>
                    <input
                      aria-label={`Select ${entry.description}`}
                      defaultChecked
                      name="selectedEntryID"
                      type="checkbox"
                      value={entry.entryID}
                    />
                    <input name="visibleEligibleID" type="hidden" value={entry.entryID} />
                  </td>
                  <td>
                    <strong>{entry.workDate}</strong>
                    <small>{entry.userName}</small>
                  </td>
                  <td>
                    <strong>{entry.customerName}</strong>
                    <small>
                      {entry.projectCode} — {entry.projectName}
                    </small>
                  </td>
                  <td className="billing-description">{entry.description}</td>
                  <td>{duration(entry.durationSeconds)}</td>
                  <td>
                    <strong>{formatScaledAmount(entry.rateScaled, entry.currency)}/h</strong>
                    <small>{formatScaledAmount(entry.amountScaled, entry.currency)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <BillingSelectionToolbar
          allMatching={{
            currencyAmounts: [...currencyAmounts].map(([currency, amountScaled]) => ({
              amountScaled,
              currency,
            })),
            durationSeconds: summary.durationSeconds,
            entryCount: summary.entryCount,
            groupCounts: [...groupCounts].map(([key, count]) => ({ count, key })),
          }}
          visibleEntries={visibleEligible.map((entry) => ({
            amountScaled: entry.amountScaled,
            currency: entry.currency,
            durationSeconds: entry.durationSeconds,
            entryID: entry.entryID,
            groupKey: `${entry.contactID}:${entry.currency}`,
          }))}
        />
        {eligibility.eligible.length > visibleEligible.length && (
          <div className="notice notice-warning">
            Showing the first 500 eligible rows. “All matching” still covers all{' '}
            {eligibility.eligible.length} rows; use narrower filters for explicit selection.
          </div>
        )}
        {visibleEligible.length === 0 && (
          <p className="muted-copy">No eligible rows match these filters.</p>
        )}
        <div className="filter-actions">
          <button
            className="button button-secondary"
            disabled={visibleEligible.length === 0}
            name="selectionType"
            type="submit"
            value="explicit"
          >
            Preview selected
          </button>
          <button
            className="button button-primary"
            disabled={eligibility.eligible.length === 0}
            name="selectionType"
            type="submit"
            value="all-matching"
          >
            Preview all matching
          </button>
        </div>
      </form>

      <section className="panel page-stack">
        <div>
          <h2>All uninvoiced</h2>
          <p>
            Explicitly preview every eligible unbilled entry without a filter. Nothing is reserved
            until confirmation.
          </p>
        </div>
        <form action={allUninvoicedPreviewAction} className="filter-actions">
          <input name="timezone" type="hidden" value={session.user.timezone} />
          <label className="field billing-invoice-date">
            <span>Invoice date</span>
            <input defaultValue={invoiceDate} name="invoiceDate" required type="date" />
          </label>
          <button
            className="button button-secondary"
            disabled={eligibility.eligible.length === 0}
            type="submit"
          >
            Preview all uninvoiced
          </button>
        </form>
      </section>

      <section className="panel page-stack">
        <div>
          <h2>Entry-specific blockers</h2>
          <p>These rows need individual attention; they are never silently selected.</p>
        </div>
        {remediation.entrySpecific.length === 0 ? (
          <p className="muted-copy">No entry-specific blockers match these filters.</p>
        ) : (
          remediation.entrySpecific.slice(0, 500).map((entry) => (
            <article className="billing-blocker-row" key={entry.entryID}>
              <div>
                <strong>
                  {entry.workDate} · {entry.customerName} · {entry.projectCode}
                </strong>
                <p>{entry.description}</p>
              </div>
              <ul>
                {entry.blockers.map((item, index) => (
                  <li key={`${item.code}:${item.remediationHref ?? ''}:${index}`}>
                    <strong>{billingBlockerLabel(item.code)}:</strong> {item.message}{' '}
                    {item.remediationHref &&
                      (canManageBillingSetup ||
                      (!item.remediationHref.startsWith('/admin') &&
                        !item.remediationHref.startsWith('/app/settings/')) ? (
                        <Link href={item.remediationHref}>
                          {billingBlockerActionLabel(item.code)}
                        </Link>
                      ) : (
                        <span className="muted-copy">Ask an owner or administrator.</span>
                      ))}
                  </li>
                ))}
              </ul>
            </article>
          ))
        )}
      </section>
    </div>
  )
}
