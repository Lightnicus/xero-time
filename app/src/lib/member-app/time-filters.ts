import { isValidCalendarDate } from '@/lib/domain/validation'

export type TimeView = 'all' | 'day' | 'week'
export type TimeBillingStatus = 'exported' | 'reserved' | 'unbilled'
export type TimeBillingStatusFilter = 'all' | TimeBillingStatus
export type TimeBillableFilter = 'no' | 'yes'

export type TimeEntryFilters = {
  anchorDate: string
  billable?: TimeBillableFilter
  billingStatus?: TimeBillingStatusFilter
  customer?: string
  project?: string
  view: TimeView
}

type SearchValue = string | string[] | undefined

const singleValue = (value: SearchValue): string => (typeof value === 'string' ? value : '')

export function shiftCalendarDate(value: string, days: number): string {
  if (!isValidCalendarDate(value) || !Number.isSafeInteger(days)) return value

  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function startOfCalendarWeek(value: string): string {
  if (!isValidCalendarDate(value)) return value

  const day = new Date(`${value}T00:00:00.000Z`).getUTCDay()
  const daysSinceMonday = (day + 6) % 7
  return shiftCalendarDate(value, -daysSinceMonday)
}

export function dateRangeForFilters(
  filters: TimeEntryFilters,
): { from: string; to: string } | null {
  if (filters.view === 'all') return null
  if (filters.view === 'day') {
    return { from: filters.anchorDate, to: filters.anchorDate }
  }

  const from = startOfCalendarWeek(filters.anchorDate)
  return { from, to: shiftCalendarDate(from, 6) }
}

export function normalizeTimeEntryFilters(
  params: Record<string, SearchValue>,
  fallbackDate: string,
): TimeEntryFilters {
  const viewValue = singleValue(params.view)
  const dateValue = singleValue(params.date)
  const projectValue = singleValue(params.project)
  const customerValue = singleValue(params.customer)
  const statusValue = singleValue(params.billingStatus)
  const billableValue = singleValue(params.billable)

  return {
    anchorDate: isValidCalendarDate(dateValue) ? dateValue : fallbackDate,
    billable: billableValue === 'yes' || billableValue === 'no' ? billableValue : undefined,
    billingStatus:
      statusValue === 'all' ||
      statusValue === 'unbilled' ||
      statusValue === 'reserved' ||
      statusValue === 'exported'
        ? statusValue
        : undefined,
    customer: customerValue.length > 0 && customerValue.length <= 100 ? customerValue : undefined,
    project: projectValue.length > 0 && projectValue.length <= 100 ? projectValue : undefined,
    view: viewValue === 'day' || viewValue === 'all' ? viewValue : 'week',
  }
}

export function searchParamsForFilters(filters: TimeEntryFilters): URLSearchParams {
  const params = new URLSearchParams({
    date: filters.anchorDate,
    view: filters.view,
  })

  if (filters.project) params.set('project', filters.project)
  if (filters.customer) params.set('customer', filters.customer)
  if (filters.billingStatus) params.set('billingStatus', filters.billingStatus)
  if (filters.billable) params.set('billable', filters.billable)

  return params
}

export function weekKeyForCalendarDate(value: string): string {
  return startOfCalendarWeek(value)
}
