import Link from 'next/link'
import { redirect } from 'next/navigation'

import { formatCalendarDateInTimezone } from '@/lib/domain/validation'
import {
  getBusinessSettings,
  listMyCustomerFilterOptions,
  listMyProjectFilterOptions,
  listMyTimeEntries,
} from '@/lib/member-app/data'
import { canLogTime, requireAppSession } from '@/lib/member-app/session'
import {
  dateRangeForFilters,
  normalizeTimeEntryFilters,
  searchParamsForFilters,
  shiftCalendarDate,
  type TimeEntryFilters,
} from '@/lib/member-app/time-filters'
import type { TimeEntry } from '@/payload-types'

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'My time | Project Time',
}

const formatDuration = (seconds: number): string => {
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

const flashMessage = (params: Record<string, string | string[] | undefined>): string | null => {
  if (params.created === '1') return 'Time entry added.'
  if (params.updated === '1') return 'Time entry updated.'
  if (params.deleted === '1') return 'Time entry deleted.'
  return null
}

const rangeLabel = (entry: TimeEntry, locale: string, use12HourTime: boolean): string | null => {
  if (!entry.startAt || !entry.endAt) return null

  const formatter = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    hour12: use12HourTime,
    minute: '2-digit',
    timeZone: entry.timezone,
  })

  return `${formatter.format(new Date(entry.startAt))}–${formatter.format(new Date(entry.endAt))}`
}

const appHref = (filters: TimeEntryFilters, page?: number): string => {
  const params = searchParamsForFilters(filters)
  if (page && page > 1) params.set('page', String(page))
  return `/app?${params.toString()}`
}

const pluralEntries = (count: number): string => `${count} ${count === 1 ? 'entry' : 'entries'}`

export default async function TimeEntriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await requireAppSession()
  const params = await searchParams
  const pageValue = typeof params.page === 'string' ? params.page : ''
  const requestedPage = /^\d+$/.test(pageValue) ? Number(pageValue) : 1
  const today = formatCalendarDateInTimezone(new Date(), session.user.timezone)
  let filters = normalizeTimeEntryFilters(params, today)
  const [settings, projectOptions, customerOptions, result] = await Promise.all([
    getBusinessSettings(session),
    listMyProjectFilterOptions(session),
    listMyCustomerFilterOptions(session),
    listMyTimeEntries(session, requestedPage, filters),
  ])

  if (filters.project && !projectOptions.some((project) => project.id === filters.project)) {
    filters = { ...filters, project: undefined }
    redirect(appHref(filters))
  }
  if (filters.customer && !customerOptions.some((customer) => customer.id === filters.customer)) {
    filters = { ...filters, customer: undefined }
    redirect(appHref(filters))
  }

  if (result.totalPages > 0 && requestedPage > result.totalPages) {
    redirect(appHref(filters, result.totalPages))
  }

  const canCreate = canLogTime(session.user)
  const message = flashMessage(params)
  const dateFormatter = new Intl.DateTimeFormat(settings.locale, {
    dateStyle: settings.dateDisplayStyle,
    timeZone: 'UTC',
  })
  const formatDate = (value: string): string => dateFormatter.format(new Date(`${value}T00:00:00Z`))
  const dateRange = dateRangeForFilters(filters)
  const periodLabel =
    filters.view === 'all'
      ? 'All recorded time'
      : filters.view === 'day'
        ? formatDate(filters.anchorDate)
        : `${formatDate(dateRange?.from ?? filters.anchorDate)} – ${formatDate(
            dateRange?.to ?? filters.anchorDate,
          )}`
  const periodStep = filters.view === 'day' ? 1 : 7
  const dailyTotals =
    filters.view === 'all' ? result.summary.daily.slice(0, 14) : result.summary.daily
  const weeklyTotals =
    filters.view === 'all' ? result.summary.weekly.slice(0, 12) : result.summary.weekly
  const hasAnyEntries = projectOptions.length > 0

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Your work</p>
          <h1>My time</h1>
          <p>Review your entries, focus a billing period, and add work for a customer project.</p>
        </div>
        {canCreate && (
          <Link className="button button-primary" href="/app/time/new">
            Add time
          </Link>
        )}
      </section>

      {message && (
        <div aria-live="polite" className="notice notice-success" role="status">
          {message}
        </div>
      )}

      {!canCreate && (
        <div className="notice">
          Your billing role can review this page, but it cannot create or change time entries.
        </div>
      )}

      <section aria-label="Time filters" className="panel filter-panel">
        <div className="period-heading">
          <div>
            <span>Viewing</span>
            <strong>{periodLabel}</strong>
          </div>
          {filters.view !== 'all' && (
            <nav aria-label="Time period" className="period-navigation">
              <Link
                aria-label="Previous period"
                className="button button-secondary"
                href={appHref({
                  ...filters,
                  anchorDate: shiftCalendarDate(filters.anchorDate, -periodStep),
                })}
              >
                Previous
              </Link>
              <Link
                className="button button-secondary"
                href={appHref({ ...filters, anchorDate: today })}
              >
                Today
              </Link>
              <Link
                aria-label="Next period"
                className="button button-secondary"
                href={appHref({
                  ...filters,
                  anchorDate: shiftCalendarDate(filters.anchorDate, periodStep),
                })}
              >
                Next
              </Link>
            </nav>
          )}
        </div>

        <form action="/app" className="filter-form" method="get">
          <div className="filter-grid">
            <label className="field" htmlFor="view">
              <span>View</span>
              <select defaultValue={filters.view} id="view" name="view">
                <option value="week">Week</option>
                <option value="day">Day</option>
                <option value="all">All time</option>
              </select>
            </label>

            <label className="field" htmlFor="date">
              <span>Day or week containing</span>
              <input defaultValue={filters.anchorDate} id="date" name="date" type="date" />
            </label>

            <label className="field" htmlFor="projectFilter">
              <span>Project</span>
              <select defaultValue={filters.project ?? ''} id="projectFilter" name="project">
                <option value="">All projects</option>
                {projectOptions.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.code} — {project.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field" htmlFor="customerFilter">
              <span>Customer</span>
              <select defaultValue={filters.customer ?? ''} id="customerFilter" name="customer">
                <option value="">All customers</option>
                {customerOptions.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field" htmlFor="billingStatus">
              <span>Billing status</span>
              <select
                defaultValue={filters.billingStatus ?? ''}
                id="billingStatus"
                name="billingStatus"
              >
                <option value="">All statuses</option>
                <option value="unbilled">Unbilled</option>
                <option value="reserved">Reserved</option>
                <option value="exported">Exported</option>
              </select>
            </label>

            <label className="field" htmlFor="billable">
              <span>Billable</span>
              <select defaultValue={filters.billable ?? ''} id="billable" name="billable">
                <option value="">All entries</option>
                <option value="yes">Billable</option>
                <option value="no">Non-billable</option>
              </select>
            </label>
          </div>

          <div className="filter-actions">
            <Link className="button button-secondary" href="/app">
              Clear filters
            </Link>
            <button className="button button-primary" type="submit">
              Apply filters
            </button>
          </div>
        </form>
      </section>

      <section aria-label="Time summary" className="summary-grid">
        <article className="summary-card">
          <span>Filtered time</span>
          <strong>{formatDuration(result.summary.durationSeconds)}</strong>
          <small>{pluralEntries(result.summary.entryCount)}</small>
        </article>
        <article className="summary-card">
          <span>Billable time</span>
          <strong>{formatDuration(result.summary.billableSeconds)}</strong>
          <small>Across the current filters</small>
        </article>
        <article className="summary-card">
          <span>Billing state</span>
          <strong>{result.summary.unbilledCount} unbilled</strong>
          <small>{result.summary.lockedCount} reserved or exported</small>
        </article>
      </section>

      <section aria-labelledby="time-totals-heading" className="panel totals-panel">
        <div className="panel-heading">
          <div>
            <h2 id="time-totals-heading">Time totals</h2>
            <p>
              Daily and weekly totals reflect every entry matching the filters, not just this page.
            </p>
          </div>
        </div>
        <div className="totals-grid">
          <div>
            <h3>Daily</h3>
            {dailyTotals.length > 0 ? (
              <ol className="totals-list">
                {dailyTotals.map((total) => (
                  <li key={total.date}>
                    <span>
                      <strong>{formatDate(total.date)}</strong>
                      <small>{pluralEntries(total.entryCount)}</small>
                    </span>
                    <strong>{formatDuration(total.durationSeconds)}</strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted-copy">No daily totals for these filters.</p>
            )}
            {filters.view === 'all' && result.summary.daily.length > dailyTotals.length && (
              <small className="totals-note">Showing the latest 14 recorded days.</small>
            )}
          </div>
          <div>
            <h3>Weekly</h3>
            {weeklyTotals.length > 0 ? (
              <ol className="totals-list">
                {weeklyTotals.map((total) => (
                  <li key={total.date}>
                    <span>
                      <strong>Week of {formatDate(total.date)}</strong>
                      <small>{pluralEntries(total.entryCount)}</small>
                    </span>
                    <strong>{formatDuration(total.durationSeconds)}</strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted-copy">No weekly totals for these filters.</p>
            )}
            {filters.view === 'all' && result.summary.weekly.length > weeklyTotals.length && (
              <small className="totals-note">Showing the latest 12 recorded weeks.</small>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="recent-time-heading" className="panel">
        <div className="panel-heading">
          <div>
            <h2 id="recent-time-heading">Time entries</h2>
            <p>
              Showing {result.entries.length} of {result.total} matching entries
            </p>
          </div>
        </div>

        {result.entries.length === 0 ? (
          <div className="empty-state">
            <h3>{hasAnyEntries ? 'No entries match these filters' : 'No time recorded yet'}</h3>
            <p>
              {hasAnyEntries
                ? 'Try another period or clear the filters to see more of your time.'
                : 'Your entries will appear here once you add your first piece of work.'}
            </p>
            {hasAnyEntries ? (
              <Link className="button button-secondary" href="/app">
                Clear filters
              </Link>
            ) : (
              canCreate && (
                <Link className="button button-primary" href="/app/time/new">
                  Add your first entry
                </Link>
              )
            )}
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="time-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Project and description</th>
                    <th>Duration</th>
                    <th>Billing</th>
                    <th>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.entries.map((entry) => {
                    const range = rangeLabel(
                      entry,
                      settings.locale,
                      settings.timeDisplayStyle === '12-hour',
                    )
                    const locked = entry.billingStatus !== 'unbilled'

                    return (
                      <tr key={entry.id}>
                        <td>
                          <strong>{formatDate(entry.workDate)}</strong>
                          {range && <small>{range}</small>}
                        </td>
                        <td>
                          <span className="project-label">
                            {entry.customerNameSnapshot} · {entry.projectCodeSnapshot} ·{' '}
                            {entry.projectNameSnapshot}
                          </span>
                          <span className="entry-description">{entry.description}</span>
                          <small className="text-capitalize">{entry.inputMode} entry</small>
                        </td>
                        <td>
                          <strong>{formatDuration(entry.durationSeconds)}</strong>
                          <small>{entry.billable ? 'Billable' : 'Non-billable'}</small>
                        </td>
                        <td>
                          <span className={`status status-${entry.billingStatus}`}>
                            {entry.billingStatus}
                          </span>
                        </td>
                        <td className="table-action">
                          <Link href={`/app/time/${entry.id}/edit`}>
                            {locked ? 'View' : 'Edit'}
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {result.totalPages > 1 && (
              <nav aria-label="Time entry pages" className="pagination">
                <span>
                  Page {result.page} of {result.totalPages}
                </span>
                <div>
                  {result.hasPrevPage ? (
                    <Link
                      className="button button-secondary"
                      href={appHref(filters, result.page - 1)}
                    >
                      Previous
                    </Link>
                  ) : (
                    <span />
                  )}
                  {result.hasNextPage && (
                    <Link
                      className="button button-secondary"
                      href={appHref(filters, result.page + 1)}
                    >
                      Next
                    </Link>
                  )}
                </div>
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  )
}
