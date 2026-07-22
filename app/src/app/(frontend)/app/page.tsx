import Link from 'next/link'
import { redirect } from 'next/navigation'

import { FilterDisclosure } from '@/app/(frontend)/_components/FilterDisclosure'
import { MetricStrip } from '@/app/(frontend)/_components/MetricStrip'
import { PageHeader } from '@/app/(frontend)/_components/PageHeader'
import { TimeEntryList } from '@/app/(frontend)/_components/TimeEntryList'
import { formatCalendarDateInTimezone } from '@/lib/domain/validation'
import {
  getBusinessSettings,
  listActiveProjectOptions,
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

import '../time-workflow.css'

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
  const [settings, activeProjects, projectOptions, customerOptions, result] = await Promise.all([
    getBusinessSettings(session),
    listActiveProjectOptions(session),
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
  const recordedDailyTotals = result.summary.daily.filter((total) => total.entryCount > 0)
  const recordedWeeklyTotals = result.summary.weekly.filter((total) => total.entryCount > 0)
  const dailyTotals =
    filters.view === 'all' ? recordedDailyTotals.slice(0, 14) : recordedDailyTotals
  const weeklyTotals =
    filters.view === 'all' ? recordedWeeklyTotals.slice(0, 12) : recordedWeeklyTotals
  const activeFilterCount = [
    filters.project,
    filters.customer,
    filters.billingStatus && filters.billingStatus !== 'unbilled'
      ? filters.billingStatus
      : undefined,
    filters.billable,
  ].filter(Boolean).length
  const hasAnyEntries = projectOptions.length > 0
  const canStartFirstEntry = canCreate && activeProjects.length > 0

  return (
    <div className="page-stack time-workflow-page">
      <PageHeader
        description="Review recorded work and focus the period you need."
        title="My time"
      />

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

      <section aria-label="Time filters" className="time-period-panel">
        <div className="time-period-heading">
          <div>
            <span>Viewing</span>
            <strong>{periodLabel}</strong>
          </div>
          {filters.view !== 'all' && (
            <nav aria-label="Time period" className="time-period-navigation">
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

        <form
          action="/app"
          className="time-filter-form"
          key={searchParamsForFilters(filters).toString()}
          method="get"
        >
          <div className="time-period-fields">
            <label className="field time-filter-field" htmlFor="view">
              <span>View</span>
              <select defaultValue={filters.view} id="view" name="view">
                <option value="week">Week</option>
                <option value="day">Day</option>
                <option value="all">All time</option>
              </select>
            </label>

            <label className="field time-filter-field time-filter-date" htmlFor="date">
              <span>Day or week containing</span>
              <input defaultValue={filters.anchorDate} id="date" name="date" type="date" />
            </label>
          </div>

          <div className="time-filter-footer">
            <FilterDisclosure activeCount={activeFilterCount} clearHref="/app">
              <div className="time-advanced-filter-grid">
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
                    defaultValue={filters.billingStatus ?? 'unbilled'}
                    id="billingStatus"
                    name="billingStatus"
                  >
                    <option value="unbilled">Unbilled</option>
                    <option value="all">All statuses</option>
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
            </FilterDisclosure>

            <button className="button button-primary time-filter-apply" type="submit">
              Apply filters
            </button>
          </div>
        </form>
      </section>

      <MetricStrip
        label="Time summary"
        metrics={[
          { label: 'Total time', value: formatDuration(result.summary.durationSeconds) },
          { label: 'Entries', value: pluralEntries(result.summary.entryCount) },
          { label: 'Billable', value: formatDuration(result.summary.billableSeconds) },
        ]}
      />

      <section aria-labelledby="recent-time-heading" className="time-entry-section">
        <div className="time-entry-section-heading">
          <div>
            <h2 id="recent-time-heading">Time entries</h2>
            <p>
              Showing {result.entries.length} of {result.total} matching entries
            </p>
          </div>
        </div>

        {result.entries.length === 0 ? (
          <div className="empty-state">
            <h3>{hasAnyEntries ? 'No entries match this view' : 'No time recorded yet'}</h3>
            <p>
              {hasAnyEntries
                ? 'Try another period, view all recorded time, or change the advanced filters.'
                : activeProjects.length > 0
                  ? 'Your entries will appear here once you add your first piece of work.'
                  : 'An active customer project is needed before time can be recorded.'}
            </p>
            {hasAnyEntries ? (
              <Link
                className="button button-secondary"
                href={appHref({ anchorDate: today, billingStatus: 'all', view: 'all' })}
              >
                View all time
              </Link>
            ) : (
              canStartFirstEntry && (
                <Link className="button button-primary" href="/app/time/new">
                  Add your first entry
                </Link>
              )
            )}
          </div>
        ) : (
          <>
            <TimeEntryList
              entries={result.entries}
              formatDate={formatDate}
              formatDuration={formatDuration}
              locale={settings.locale}
              use12HourTime={settings.timeDisplayStyle === '12-hour'}
            />

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

      {result.summary.entryCount > 0 && (
        <details className="time-breakdown">
          <summary>View daily and weekly breakdown</summary>
          <section aria-label="Time totals" className="time-breakdown-content">
            <p>Totals include every entry matching these filters, not only the current page.</p>
            <div className="time-breakdown-grid">
              <div>
                <h3>Daily</h3>
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
                {filters.view === 'all' && recordedDailyTotals.length > dailyTotals.length && (
                  <small className="totals-note">Showing the latest 14 recorded days.</small>
                )}
              </div>
              <div>
                <h3>Weekly</h3>
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
                {filters.view === 'all' && recordedWeeklyTotals.length > weeklyTotals.length && (
                  <small className="totals-note">Showing the latest 12 recorded weeks.</small>
                )}
              </div>
            </div>
          </section>
        </details>
      )}
    </div>
  )
}
