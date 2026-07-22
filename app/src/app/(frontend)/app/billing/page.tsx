import Link from 'next/link'
import { redirect } from 'next/navigation'

import { hasActiveRole } from '@/access/roles'
import { BillingSelectionToolbar } from '@/app/(frontend)/_components/BillingSelectionToolbar'
import { FilterDisclosure } from '@/app/(frontend)/_components/FilterDisclosure'
import { MetricStrip } from '@/app/(frontend)/_components/MetricStrip'
import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
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

import '../../billing-workflow.css'

export const metadata: Metadata = { title: 'Billing queue | Project Time' }

type Params = Record<string, string | string[] | undefined>

const BILLING_QUEUE_CAPACITY_MESSAGE =
  'The billing query exceeds 20,000 entries. Narrow the date or customer filter.'
const ALL_UNINVOICED_CAPACITY_MESSAGE =
  'All uninvoiced is unavailable for more than 20,000 entries. Apply date or customer filters and use All matching filters.'

const param = (params: Params, name: string): string =>
  typeof params[name] === 'string' ? params[name] : ''

const duration = (seconds: number): string => {
  const minutes = seconds / 60
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const toolbarSummary = (
  entries: Array<{
    amountScaled: number
    contactID: string
    currency: string
    durationSeconds: number
  }>,
) => {
  const currencyAmounts = new Map<string, number>()
  const groupCounts = new Map<string, number>()
  let durationSeconds = 0

  for (const entry of entries) {
    durationSeconds += entry.durationSeconds
    currencyAmounts.set(
      entry.currency,
      (currencyAmounts.get(entry.currency) ?? 0) + entry.amountScaled,
    )
    const groupKey = `${entry.contactID}:${entry.currency}`
    groupCounts.set(groupKey, (groupCounts.get(groupKey) ?? 0) + 1)
  }

  return {
    currencyAmounts: [...currencyAmounts].map(([currency, amountScaled]) => ({
      amountScaled,
      currency,
    })),
    durationSeconds,
    entryCount: entries.length,
    groupCounts: [...groupCounts].map(([key, count]) => ({ count, key })),
  }
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
      message:
        'Xero sales items, accounts, tax types, currencies, tracking, and invoice permissions were refreshed.',
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
  const hasQueueFilter = [
    filter.blocker,
    filter.currency,
    filter.customerID,
    filter.dateFrom,
    filter.dateTo,
    filter.projectID,
    filter.userID,
  ].some(Boolean)
  let allUninvoicedEligibility = hasQueueFilter ? null : eligibility
  let allUninvoicedUnavailableReason: string | undefined
  if (hasQueueFilter) {
    try {
      allUninvoicedEligibility = await getBillingEligibility(session, {
        timezone: session.user.timezone,
      })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== BILLING_QUEUE_CAPACITY_MESSAGE) throw error
      allUninvoicedUnavailableReason = ALL_UNINVOICED_CAPACITY_MESSAGE
    }
  }
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
  const allMatchingToolbarSummary = toolbarSummary(eligibility.eligible)
  const allUninvoicedToolbarSummary = allUninvoicedEligibility
    ? toolbarSummary(allUninvoicedEligibility.eligible)
    : null
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
  const advancedFilterCount = [
    normalizedFilter.userID,
    normalizedFilter.currency,
    normalizedFilter.blocker,
  ].filter(Boolean).length

  return (
    <div className="wide-page page-stack billing-workflow-page">
      <PageHeader
        action={
          <Link className="button button-secondary" href="/app/billing/exports">
            Export history
          </Link>
        }
        description="Choose eligible time, then review the exact draft invoices before anything is created."
        title="Billing queue"
      />

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

      <section className="billing-filter-surface" aria-label="Billing filters">
        <form className="billing-filter-form" method="get">
          <div className="billing-common-filter-grid">
            <label className="field billing-filter-field">
              <span>From</span>
              <input defaultValue={param(params, 'dateFrom')} name="dateFrom" type="date" />
            </label>
            <label className="field billing-filter-field">
              <span>To</span>
              <input defaultValue={param(params, 'dateTo')} name="dateTo" type="date" />
            </label>
            <label className="field billing-filter-field">
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
            <label className="field billing-filter-field">
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
          </div>
          <div className="billing-filter-footer">
            <FilterDisclosure activeCount={advancedFilterCount} clearHref="/app/billing">
              <div className="billing-advanced-filter-grid">
                <label className="field billing-filter-field">
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
                <label className="field billing-filter-field">
                  <span>Currency</span>
                  <input
                    defaultValue={param(params, 'currency')}
                    maxLength={3}
                    name="currency"
                    placeholder="NZD"
                  />
                </label>
                <label className="field billing-filter-field">
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
            </FilterDisclosure>
            <button className="button button-primary billing-filter-apply" type="submit">
              Apply filters
            </button>
          </div>
        </form>
      </section>

      <MetricStrip
        label="Eligible billing summary"
        metrics={[
          {
            label: 'Eligible time',
            value: `${summary.entryCount} ${summary.entryCount === 1 ? 'entry' : 'entries'} · ${duration(summary.durationSeconds)}`,
          },
          { label: 'Draft invoices', value: String(summary.invoiceCount) },
          {
            label: 'Pre-tax value',
            value:
              summary.currencies.length === 1
                ? formatScaledAmount(summary.amountScaled, summary.currencies[0] as string)
                : `${summary.currencies.length} currencies`,
          },
        ]}
      />

      <form action={startBillingPreviewAction} className="billing-queue-surface">
        {hiddenFilter(normalizedFilter)}
        <div className="billing-invoice-date-row">
          <label className="field billing-filter-field billing-invoice-date-field">
            <span>Invoice date</span>
            <input defaultValue={invoiceDate} name="invoiceDate" required type="date" />
          </label>
          <p>This date applies to every draft in the chosen scope.</p>
        </div>
        <BillingSelectionToolbar
          allMatching={allMatchingToolbarSummary}
          allUninvoiced={allUninvoicedToolbarSummary}
          allUninvoicedAction={allUninvoicedPreviewAction}
          allUninvoicedUnavailableReason={allUninvoicedUnavailableReason}
          visibleEntries={visibleEligible.map((entry) => ({
            amountScaled: entry.amountScaled,
            currency: entry.currency,
            durationSeconds: entry.durationSeconds,
            entryID: entry.entryID,
            groupKey: `${entry.contactID}:${entry.currency}`,
          }))}
        >
          <div className="billing-entry-table-shell">
            <table className="billing-workflow-table" id="billing-eligible-table">
              <caption className="visually-hidden">Eligible time entries</caption>
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
                    <td className="billing-select-cell">
                      <label className="billing-row-selector">
                        <input
                          aria-label={`Select ${entry.description}`}
                          defaultChecked
                          name="selectedEntryID"
                          type="checkbox"
                          value={entry.entryID}
                        />
                        <span>Include in review</span>
                      </label>
                      <input name="visibleEligibleID" type="hidden" value={entry.entryID} />
                    </td>
                    <td>
                      <span className="billing-mobile-label">Date / user</span>
                      <strong>{entry.workDate}</strong>
                      <small>{entry.userName}</small>
                    </td>
                    <td>
                      <span className="billing-mobile-label">Customer / project</span>
                      <strong>{entry.customerName}</strong>
                      <small>
                        {entry.projectCode} — {entry.projectName}
                      </small>
                    </td>
                    <td className="billing-workflow-description">
                      <span className="billing-mobile-label">Description</span>
                      {entry.description}
                    </td>
                    <td>
                      <span className="billing-mobile-label">Time</span>
                      {duration(entry.durationSeconds)}
                    </td>
                    <td>
                      <span className="billing-mobile-label">Rate / amount</span>
                      <strong>{formatScaledAmount(entry.rateScaled, entry.currency)}/h</strong>
                      <small>{formatScaledAmount(entry.amountScaled, entry.currency)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {eligibility.eligible.length > visibleEligible.length && (
            <div className="notice notice-warning">
              Showing the first 500 eligible rows. “All matching” still covers all{' '}
              {eligibility.eligible.length} rows; use narrower filters for explicit selection.
            </div>
          )}
          {visibleEligible.length === 0 && (
            <p className="muted-copy">No eligible rows match these filters.</p>
          )}
        </BillingSelectionToolbar>
      </form>

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
