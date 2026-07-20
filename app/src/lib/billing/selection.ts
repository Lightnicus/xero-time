import { BILLING_BLOCKER_CODES } from './contracts'

import type {
  BillingEligibilityResult,
  BillingFilter,
  BillingSelection,
  BillingSelectionSummary,
  EligibleBillingEntry,
} from './contracts'

const calendarDate = /^\d{4}-\d{2}-\d{2}$/
const safeID = /^[A-Za-z0-9_-]{1,100}$/

const normalizedID = (value: unknown): string | undefined =>
  typeof value === 'string' && safeID.test(value) ? value : undefined

export function normalizeBillingFilter(input: Partial<BillingFilter>): BillingFilter {
  const dateFrom =
    typeof input.dateFrom === 'string' && calendarDate.test(input.dateFrom)
      ? input.dateFrom
      : undefined
  const dateTo =
    typeof input.dateTo === 'string' && calendarDate.test(input.dateTo) ? input.dateTo : undefined
  if (dateFrom && dateTo && dateFrom > dateTo)
    throw new Error('The start date must not be after the end date.')

  const currency =
    typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency.toUpperCase())
      ? input.currency.toUpperCase()
      : undefined
  const blocker = BILLING_BLOCKER_CODES.includes(input.blocker as never) ? input.blocker : undefined

  return {
    blocker,
    currency,
    customerID: normalizedID(input.customerID),
    dateFrom,
    dateTo,
    projectID: normalizedID(input.projectID),
    timezone:
      typeof input.timezone === 'string' && input.timezone.length <= 100
        ? input.timezone
        : 'Pacific/Auckland',
    userID: normalizedID(input.userID),
  }
}

const uniqueIDs = (values: readonly string[]): string[] => {
  const normalized = values.map(normalizedID)
  if (normalized.some((value) => !value))
    throw new Error('The selection contains an invalid entry ID.')
  return [...new Set(normalized as string[])].sort()
}

export function normalizeBillingSelection(input: BillingSelection): BillingSelection {
  const explicitEntryIDs = uniqueIDs(input.explicitEntryIDs)
  const excludedEntryIDs = uniqueIDs(input.excludedEntryIDs)
  if (input.type === 'explicit' && explicitEntryIDs.length === 0) {
    throw new Error('Select at least one time entry.')
  }
  if (input.type !== 'explicit' && input.type !== 'all-matching') {
    throw new Error('Choose a supported billing selection.')
  }
  return {
    excludedEntryIDs,
    explicitEntryIDs,
    filter: normalizeBillingFilter(input.filter),
    type: input.type,
  }
}

export function selectEligibleEntries(
  result: BillingEligibilityResult,
  selectionInput: BillingSelection,
): EligibleBillingEntry[] {
  const selection = normalizeBillingSelection(selectionInput)
  const excluded = new Set(selection.excludedEntryIDs)
  const byID = new Map(result.eligible.map((entry) => [entry.entryID, entry]))

  if (selection.type === 'explicit') {
    const missing = selection.explicitEntryIDs.filter((id) => !byID.has(id))
    if (missing.length > 0) {
      throw new Error(
        `Some selected entries are no longer eligible or accessible: ${missing.join(', ')}. Refresh the billing queue.`,
      )
    }
    return selection.explicitEntryIDs
      .filter((id) => !excluded.has(id))
      .map((id) => byID.get(id) as EligibleBillingEntry)
  }

  return result.eligible.filter((entry) => !excluded.has(entry.entryID))
}

export function summarizeSelection(
  entries: readonly EligibleBillingEntry[],
): BillingSelectionSummary {
  const dates = entries.map((entry) => entry.workDate).sort()
  const groups = new Set(entries.map((entry) => `${entry.customerID}\u0000${entry.currency}`))
  return {
    amountScaled: entries.reduce((total, entry) => total + entry.amountScaled, 0),
    currencies: [...new Set(entries.map((entry) => entry.currency))].sort(),
    durationSeconds: entries.reduce((total, entry) => total + entry.durationSeconds, 0),
    entryCount: entries.length,
    invoiceCount: groups.size,
    newestWorkDate: dates.at(-1),
    oldestWorkDate: dates[0],
  }
}
