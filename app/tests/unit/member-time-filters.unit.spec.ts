import { describe, expect, it } from 'vitest'

import {
  dateRangeForFilters,
  normalizeTimeEntryFilters,
  searchParamsForFilters,
  shiftCalendarDate,
  startOfCalendarWeek,
} from '@/lib/member-app/time-filters'

describe('member time filters', () => {
  it('defaults to the week containing the fallback date', () => {
    const filters = normalizeTimeEntryFilters({}, '2026-07-18')

    expect(filters).toEqual({ anchorDate: '2026-07-18', view: 'week' })
    expect(dateRangeForFilters(filters)).toEqual({ from: '2026-07-13', to: '2026-07-19' })
  })

  it('normalizes day and all-time views', () => {
    expect(
      dateRangeForFilters(normalizeTimeEntryFilters({ date: '2026-07-18', view: 'day' }, 'x')),
    ).toEqual({ from: '2026-07-18', to: '2026-07-18' })
    expect(
      dateRangeForFilters(normalizeTimeEntryFilters({ date: '2026-07-18', view: 'all' }, 'x')),
    ).toBeNull()
  })

  it('rejects unknown enum values and malformed dates', () => {
    expect(
      normalizeTimeEntryFilters(
        {
          billable: 'sometimes',
          billingStatus: 'paid',
          date: '2026-02-30',
          project: 'x'.repeat(101),
          view: 'month',
        },
        '2026-07-18',
      ),
    ).toEqual({ anchorDate: '2026-07-18', view: 'week' })
  })

  it('keeps allow-listed filters in generated links', () => {
    const filters = normalizeTimeEntryFilters(
      {
        billable: 'no',
        billingStatus: 'unbilled',
        date: '2026-07-18',
        project: 'project-id',
        view: 'day',
      },
      '2026-07-01',
    )

    expect(searchParamsForFilters(filters).toString()).toBe(
      'date=2026-07-18&view=day&project=project-id&billingStatus=unbilled&billable=no',
    )
  })

  it('shifts dates and starts weeks on Monday across month boundaries', () => {
    expect(shiftCalendarDate('2026-08-01', -1)).toBe('2026-07-31')
    expect(startOfCalendarWeek('2026-08-02')).toBe('2026-07-27')
  })
})
