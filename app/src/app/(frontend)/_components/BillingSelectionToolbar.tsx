'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { formatScaledAmount } from '@/lib/domain/money'

import type { ReactNode } from 'react'

type VisibleEntry = {
  amountScaled: number
  currency: string
  durationSeconds: number
  entryID: string
  groupKey: string
}

type AllMatchingSummary = {
  currencyAmounts: Array<{ amountScaled: number; currency: string }>
  durationSeconds: number
  entryCount: number
  groupCounts: Array<{ count: number; key: string }>
}

type SelectionSummary = {
  currencyAmounts: Map<string, number>
  durationSeconds: number
  entryCount: number
  invoiceCount: number
}

type BillingScope = 'all-matching' | 'all-uninvoiced' | 'explicit'

type ServerAction = (formData: FormData) => Promise<void>

const duration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const valueLabel = (currencyAmounts: Map<string, number>): string => {
  const values = [...currencyAmounts.entries()].filter(([, value]) => value > 0)
  if (values.length === 0) return 'No value selected'
  if (values.length > 1) return `${values.length} currencies`
  const [currency, value] = values[0] as [string, number]
  return formatScaledAmount(value, currency)
}

const summarizeVisibleEntries = (entries: VisibleEntry[]): SelectionSummary => {
  const currencyAmounts = new Map<string, number>()
  const groups = new Set<string>()
  let durationSeconds = 0

  for (const entry of entries) {
    durationSeconds += entry.durationSeconds
    currencyAmounts.set(
      entry.currency,
      (currencyAmounts.get(entry.currency) ?? 0) + entry.amountScaled,
    )
    groups.add(entry.groupKey)
  }

  return {
    currencyAmounts,
    durationSeconds,
    entryCount: entries.length,
    invoiceCount: groups.size,
  }
}

const summarizeAllMatching = (summary: AllMatchingSummary): SelectionSummary => ({
  currencyAmounts: new Map(
    summary.currencyAmounts.map((item) => [item.currency, item.amountScaled]),
  ),
  durationSeconds: summary.durationSeconds,
  entryCount: summary.entryCount,
  invoiceCount: summary.groupCounts.filter((item) => item.count > 0).length,
})

const summaryLabel = (summary: SelectionSummary): string =>
  `${summary.entryCount} ${summary.entryCount === 1 ? 'entry' : 'entries'} · ${duration(
    summary.durationSeconds,
  )} · ${valueLabel(summary.currencyAmounts)} · ${summary.invoiceCount} ${
    summary.invoiceCount === 1 ? 'draft invoice' : 'draft invoices'
  }`

export function BillingSelectionToolbar({
  allMatching,
  allUninvoiced,
  allUninvoicedAction,
  allUninvoicedUnavailableReason,
  children,
  visibleEntries,
}: {
  allMatching: AllMatchingSummary
  allUninvoiced: AllMatchingSummary | null
  allUninvoicedAction: ServerAction
  allUninvoicedUnavailableReason?: string
  children: ReactNode
  visibleEntries: VisibleEntry[]
}) {
  const root = useRef<HTMLDivElement>(null)
  const [scope, setScope] = useState<BillingScope>('explicit')
  const [explicit, setExplicit] = useState<SelectionSummary>(() =>
    summarizeVisibleEntries(visibleEntries),
  )
  const [matching, setMatching] = useState<SelectionSummary>(() =>
    summarizeAllMatching(allMatching),
  )
  const uninvoiced = allUninvoiced ? summarizeAllMatching(allUninvoiced) : null

  const refresh = useCallback(() => {
    const form = root.current?.closest('form')
    if (!form) return
    const selectedIDs = new Set(
      [...form.querySelectorAll<HTMLInputElement>('input[name="selectedEntryID"]')]
        .filter((input) => input.checked)
        .map((input) => input.value),
    )
    const selectedEntries = visibleEntries.filter((entry) => selectedIDs.has(entry.entryID))
    const excludedEntries = visibleEntries.filter((entry) => !selectedIDs.has(entry.entryID))
    setExplicit(summarizeVisibleEntries(selectedEntries))

    const matchingCurrencies = new Map(
      allMatching.currencyAmounts.map((item) => [item.currency, item.amountScaled]),
    )
    const matchingGroups = new Map(allMatching.groupCounts.map((item) => [item.key, item.count]))
    let matchingDuration = allMatching.durationSeconds
    for (const entry of excludedEntries) {
      matchingDuration -= entry.durationSeconds
      matchingCurrencies.set(
        entry.currency,
        (matchingCurrencies.get(entry.currency) ?? 0) - entry.amountScaled,
      )
      matchingGroups.set(entry.groupKey, (matchingGroups.get(entry.groupKey) ?? 0) - 1)
    }
    setMatching({
      currencyAmounts: matchingCurrencies,
      durationSeconds: matchingDuration,
      entryCount: allMatching.entryCount - excludedEntries.length,
      invoiceCount: [...matchingGroups.values()].filter((count) => count > 0).length,
    })
  }, [allMatching, visibleEntries])

  useEffect(() => {
    const form = root.current?.closest('form')
    if (!form) return
    const inputs = [...form.querySelectorAll<HTMLInputElement>('input[name="selectedEntryID"]')]
    for (const input of inputs) input.addEventListener('change', refresh)
    refresh()
    return () => {
      for (const input of inputs) input.removeEventListener('change', refresh)
    }
  }, [refresh])

  const setVisible = (checked: boolean): void => {
    const form = root.current?.closest('form')
    if (!form) return
    for (const input of form.querySelectorAll<HTMLInputElement>('input[name="selectedEntryID"]')) {
      input.checked = checked
    }
    refresh()
  }

  const chosenSummary = scope === 'explicit' ? explicit : matching
  const actionDisabled =
    scope === 'explicit'
      ? explicit.entryCount === 0
      : scope === 'all-matching'
        ? matching.entryCount === 0
        : !uninvoiced || uninvoiced.entryCount === 0
  const disabledReason =
    scope === 'explicit'
      ? 'Select at least one row to review.'
      : scope === 'all-matching'
        ? 'No eligible entries remain in the current filters.'
        : (allUninvoicedUnavailableReason ?? 'There are no eligible uninvoiced entries to review.')

  return (
    <div className="billing-selection-toolbar" ref={root}>
      <div className="billing-selection-heading">
        <div>
          <h2>Choose what to invoice</h2>
          <p>Pick a scope, check the summary, then review the drafts before creating anything.</p>
        </div>
        <div className="billing-visible-actions" aria-label="Visible row selection">
          <button
            className="button button-secondary"
            disabled={visibleEntries.length === 0 || scope === 'all-uninvoiced'}
            onClick={() => setVisible(true)}
            type="button"
          >
            Select visible
          </button>
          <button
            className="button button-secondary"
            disabled={visibleEntries.length === 0 || scope === 'all-uninvoiced'}
            onClick={() => setVisible(false)}
            type="button"
          >
            Clear visible
          </button>
        </div>
      </div>

      <fieldset className="billing-scope-fieldset">
        <legend>Invoice scope</legend>
        <div className="billing-scope-options">
          <label className="billing-scope-option">
            <input
              checked={scope === 'explicit'}
              name="billingScope"
              onChange={() => setScope('explicit')}
              type="radio"
              value="explicit"
            />
            <span>
              <strong>Selected rows</strong>
              <small>Only the checked rows in this queue.</small>
            </span>
          </label>
          <label className="billing-scope-option">
            <input
              checked={scope === 'all-matching'}
              name="billingScope"
              onChange={() => setScope('all-matching')}
              type="radio"
              value="all-matching"
            />
            <span>
              <strong>All matching filters</strong>
              <small>Every match, minus any visible rows you clear.</small>
            </span>
          </label>
          <label className="billing-scope-option">
            <input
              checked={scope === 'all-uninvoiced'}
              disabled={!uninvoiced}
              name="billingScope"
              onChange={() => setScope('all-uninvoiced')}
              type="radio"
              value="all-uninvoiced"
            />
            <span>
              <strong>All uninvoiced</strong>
              <small>
                {allUninvoicedUnavailableReason ??
                  'Every eligible entry, ignoring the current filters and row choices.'}
              </small>
            </span>
          </label>
        </div>
      </fieldset>

      <div className="billing-selection-rows">{children}</div>

      <div aria-atomic="true" aria-live="polite" className="billing-scope-summary">
        <span>{scope === 'all-uninvoiced' ? 'All uninvoiced' : 'Current scope'}</span>
        <strong>
          {scope === 'all-uninvoiced' && uninvoiced
            ? summaryLabel(uninvoiced)
            : summaryLabel(chosenSummary)}
        </strong>
      </div>

      <div className="billing-review-action">
        {actionDisabled && <p>{disabledReason}</p>}
        <button
          className="button button-primary"
          disabled={actionDisabled}
          formAction={scope === 'all-uninvoiced' ? allUninvoicedAction : undefined}
          name={scope === 'all-uninvoiced' ? undefined : 'selectionType'}
          type="submit"
          value={
            scope === 'all-uninvoiced'
              ? undefined
              : scope === 'explicit'
                ? 'explicit'
                : 'all-matching'
          }
        >
          Review draft invoices
        </button>
      </div>
    </div>
  )
}
