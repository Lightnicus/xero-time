'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

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

const scaledAmount = (value: number, currency: string): string => {
  const whole = Math.floor(value / 10_000)
  const fraction = String(value % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0')
  return `${currency} ${whole.toLocaleString('en-NZ')}.${fraction}`
}

const duration = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const valueLabel = (currencyAmounts: Map<string, number>): string => {
  const values = [...currencyAmounts.entries()].filter(([, value]) => value > 0)
  if (values.length === 0) return 'No value selected'
  if (values.length > 1) return `${values.length} currencies`
  const [currency, value] = values[0] as [string, number]
  return scaledAmount(value, currency)
}

const emptySummary = (): SelectionSummary => ({
  currencyAmounts: new Map(),
  durationSeconds: 0,
  entryCount: 0,
  invoiceCount: 0,
})

export function BillingSelectionToolbar({
  allMatching,
  visibleEntries,
}: {
  allMatching: AllMatchingSummary
  visibleEntries: VisibleEntry[]
}) {
  const root = useRef<HTMLDivElement>(null)
  const [explicit, setExplicit] = useState<SelectionSummary>(emptySummary)
  const [matching, setMatching] = useState<SelectionSummary>(emptySummary)

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
    const explicitCurrencies = new Map<string, number>()
    const explicitGroups = new Set<string>()
    let explicitDuration = 0
    for (const entry of selectedEntries) {
      explicitDuration += entry.durationSeconds
      explicitCurrencies.set(
        entry.currency,
        (explicitCurrencies.get(entry.currency) ?? 0) + entry.amountScaled,
      )
      explicitGroups.add(entry.groupKey)
    }
    setExplicit({
      currencyAmounts: explicitCurrencies,
      durationSeconds: explicitDuration,
      entryCount: selectedEntries.length,
      invoiceCount: explicitGroups.size,
    })

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

  return (
    <div className="billing-selection-toolbar page-stack" ref={root}>
      <div className="filter-actions">
        <button className="button button-secondary" onClick={() => setVisible(true)} type="button">
          Select visible
        </button>
        <button className="button button-secondary" onClick={() => setVisible(false)} type="button">
          Clear visible
        </button>
      </div>
      <div className="selection-summary-grid" role="status">
        <div>
          <strong>Selected preview</strong>
          <span>
            {explicit.entryCount} entries · {duration(explicit.durationSeconds)} ·{' '}
            {valueLabel(explicit.currencyAmounts)} · {explicit.invoiceCount} invoices
          </span>
        </div>
        <div>
          <strong>All matching preview</strong>
          <span>
            {matching.entryCount} entries · {duration(matching.durationSeconds)} ·{' '}
            {valueLabel(matching.currencyAmounts)} · {matching.invoiceCount} invoices
          </span>
        </div>
      </div>
    </div>
  )
}
