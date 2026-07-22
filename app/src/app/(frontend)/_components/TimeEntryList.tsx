import Link from 'next/link'

import type { TimeEntry } from '@/payload-types'

type TimeEntryListProps = {
  entries: TimeEntry[]
  formatDate: (value: string) => string
  formatDuration: (seconds: number) => string
  locale: string
  use12HourTime: boolean
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

export function TimeEntryList({
  entries,
  formatDate,
  formatDuration,
  locale,
  use12HourTime,
}: TimeEntryListProps) {
  return (
    <div className="time-entry-table-shell">
      <table className="time-entry-table">
        <thead>
          <tr>
            <th>Project and description</th>
            <th>Date</th>
            <th>Duration</th>
            <th>Status</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const range = rangeLabel(entry, locale, use12HourTime)
            const locked = entry.billingStatus !== 'unbilled'

            return (
              <tr key={entry.id}>
                <td className="time-entry-work">
                  <span className="time-entry-project">
                    {entry.customerNameSnapshot} · {entry.projectCodeSnapshot} ·{' '}
                    {entry.projectNameSnapshot}
                  </span>
                  <span className="time-entry-description">{entry.description}</span>
                  <small className="text-capitalize">{entry.inputMode} entry</small>
                </td>
                <td>
                  <span aria-hidden="true" className="time-entry-mobile-label">
                    Date
                  </span>
                  <strong>{formatDate(entry.workDate)}</strong>
                  {range && <small>{range}</small>}
                </td>
                <td>
                  <span aria-hidden="true" className="time-entry-mobile-label">
                    Duration
                  </span>
                  <strong>{formatDuration(entry.durationSeconds)}</strong>
                  <small>{entry.billable ? 'Billable' : 'Non-billable'}</small>
                </td>
                <td>
                  <span aria-hidden="true" className="time-entry-mobile-label">
                    Status
                  </span>
                  <span className={`status status-${entry.billingStatus}`}>
                    {entry.billingStatus}
                  </span>
                </td>
                <td className="time-entry-action">
                  <Link href={`/app/time/${entry.id}/edit`}>{locked ? 'View' : 'Edit'}</Link>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
