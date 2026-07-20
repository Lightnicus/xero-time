import { describe, expect, it } from 'vitest'

import type { EligibleBillingEntry } from '@/lib/billing/contracts'
import { durationToQuantityScaled, quantityRateAmountScaled, taxForLine } from '@/lib/billing/math'
import { buildBillingPreview, dueDateFor } from '@/lib/billing/preview'
import {
  normalizeBillingFilter,
  normalizeBillingSelection,
  selectEligibleEntries,
  summarizeSelection,
} from '@/lib/billing/selection'
import { stableHash, stableJSON } from '@/lib/billing/stable'

const entry = (overrides: Partial<EligibleBillingEntry> = {}): EligibleBillingEntry => ({
  accountCode: '200',
  amountScaled: 25050,
  contactID: '11111111-1111-4111-8111-111111111111',
  contactName: 'Example Customer',
  currency: 'NZD',
  customerID: 'customer-1',
  customerName: 'Example Customer',
  customerReferenceCode: 'EXAMPLE',
  customerReferenceLastSequence: null,
  customerReferenceSequence: 1,
  customerReferenceStartNumber: 1,
  description: 'Complete implementation detail',
  durationSeconds: 60,
  entryID: 'entry-1',
  itemCode: 'TIME',
  itemID: '22222222-2222-4222-8222-222222222222',
  itemName: 'Professional services',
  projectCode: 'WEB',
  projectID: 'project-1',
  projectName: 'Website',
  rateScaled: 1_500_000,
  taxRatePercent: 15,
  taxType: 'OUTPUT2',
  timezone: 'Pacific/Auckland',
  tracking: [{ name: 'Region', option: 'Auckland' }],
  updatedAt: '2026-07-18T00:00:00.000Z',
  userID: 'user-1',
  userName: 'Test User',
  workDate: '2026-07-18',
  ...overrides,
})

const settings = {
  defaultRevenueAccountCode: '200',
  defaultTaxType: 'OUTPUT2',
  invoiceLineDescriptionTemplate: '{{workDate}} · {{projectCode}} · {{description}}',
  lineAmountType: 'Exclusive' as const,
  paymentTerms: { basis: 'days-after-invoice' as const, value: 14 },
}

describe('billing scaled arithmetic', () => {
  it('uses the visible four-decimal Xero quantity boundary for one minute', () => {
    expect(durationToQuantityScaled(60)).toBe(167)
    expect(quantityRateAmountScaled(167, 1_500_000)).toBe(25_050)
    expect(taxForLine(25_050, 15, 'Exclusive')).toBe(3_758)
  })

  it('rejects fractional minutes, invalid rates, and unsafe values', () => {
    expect(() => durationToQuantityScaled(61)).toThrow()
    expect(() => quantityRateAmountScaled(100, -1)).toThrow()
    expect(() =>
      quantityRateAmountScaled(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    ).toThrow()
  })

  it('calculates exclusive, inclusive, and no-tax lines deterministically', () => {
    expect(taxForLine(100_000, 15, 'Exclusive')).toBe(15_000)
    expect(taxForLine(115_000, 15, 'Inclusive')).toBe(15_000)
    expect(taxForLine(100_000, 15, 'NoTax')).toBe(0)
  })
})

describe('billing selection semantics', () => {
  const eligibility = {
    blocked: [],
    eligible: [entry(), entry({ entryID: 'entry-2', workDate: '2026-07-19' })],
    generatedAt: '2026-07-18T00:00:00.000Z',
  }

  it('normalizes filters and rejects reversed dates', () => {
    expect(normalizeBillingFilter({ currency: 'nzd', timezone: 'Pacific/Auckland' })).toMatchObject(
      {
        currency: 'NZD',
      },
    )
    expect(() => normalizeBillingFilter({ dateFrom: '2026-07-20', dateTo: '2026-07-18' })).toThrow()
  })

  it('implements explicit selection without silently dropping stale IDs', () => {
    const selection = normalizeBillingSelection({
      excludedEntryIDs: [],
      explicitEntryIDs: ['entry-2'],
      filter: normalizeBillingFilter({}),
      type: 'explicit',
    })
    expect(selectEligibleEntries(eligibility, selection).map((item) => item.entryID)).toEqual([
      'entry-2',
    ])
    expect(() =>
      selectEligibleEntries(eligibility, {
        ...selection,
        explicitEntryIDs: ['missing-entry'],
      }),
    ).toThrow(/no longer eligible/)
  })

  it('applies all-matching exclusions to the complete resolved set', () => {
    const selected = selectEligibleEntries(eligibility, {
      excludedEntryIDs: ['entry-1'],
      explicitEntryIDs: [],
      filter: normalizeBillingFilter({}),
      type: 'all-matching',
    })
    expect(selected.map((item) => item.entryID)).toEqual(['entry-2'])
    expect(summarizeSelection(eligibility.eligible)).toMatchObject({
      entryCount: 2,
      invoiceCount: 1,
      newestWorkDate: '2026-07-19',
      oldestWorkDate: '2026-07-18',
    })
  })
})

describe('invoice preview construction', () => {
  it('groups by local customer/currency, combines projects, and keeps one line per entry', () => {
    const preview = buildBillingPreview({
      batchReference: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      entries: [
        entry(),
        entry({
          description: 'Second complete description',
          entryID: 'entry-2',
          projectCode: 'APP',
          projectID: 'project-2',
          projectName: 'Application',
        }),
        entry({
          contactName: 'Second Customer',
          customerID: 'customer-2',
          customerName: 'Second Customer',
          customerReferenceCode: 'SECOND',
          entryID: 'entry-3',
        }),
      ],
      invoiceDate: '2026-07-18',
      settings,
    })

    expect(preview.invoices).toHaveLength(2)
    expect(preview.invoices[0]?.lines).toHaveLength(2)
    expect(preview.invoices.flatMap((invoice) => invoice.lines)).toHaveLength(3)
    expect(preview.invoices[0]?.lines[0]?.lineDescription).toContain(
      'Complete implementation detail',
    )
    expect(preview.invoices.map((invoice) => invoice.applicationReference)).toEqual([
      'EXAMPLE-0001',
      'SECOND-0001',
    ])
    expect(preview.invoices[0]?.payload).toMatchObject({
      LineItems: expect.arrayContaining([expect.objectContaining({ ItemCode: 'TIME' })]),
      Status: 'DRAFT',
      Type: 'ACCREC',
    })
  })

  it('binds the selected Xero item identity and code into the immutable preview hashes', () => {
    const base = buildBillingPreview({
      batchReference: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      entries: [entry()],
      invoiceDate: '2026-07-18',
      settings,
    })
    const renamed = buildBillingPreview({
      batchReference: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      entries: [entry({ itemCode: 'TIME-NEW' })],
      invoiceDate: '2026-07-18',
      settings,
    })
    const replaced = buildBillingPreview({
      batchReference: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      entries: [entry({ itemID: '33333333-3333-4333-8333-333333333333' })],
      invoiceDate: '2026-07-18',
      settings,
    })

    expect(renamed.selectionHash).not.toBe(base.selectionHash)
    expect(renamed.checksum).not.toBe(base.checksum)
    expect(replaced.selectionHash).not.toBe(base.selectionHash)
  })

  it('uses the configured starting number and pads only sequences shorter than four digits', () => {
    const starting = buildBillingPreview({
      batchReference: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      entries: [
        entry({
          customerReferenceCode: 'CUSTOMER',
          customerReferenceSequence: 42,
          customerReferenceStartNumber: 42,
        }),
      ],
      invoiceDate: '2026-07-18',
      settings,
    })
    const large = buildBillingPreview({
      batchReference: 'FFFFFFFF-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      entries: [
        entry({
          customerReferenceCode: 'CUSTOMER',
          customerReferenceLastSequence: 9_999,
          customerReferenceSequence: 10_000,
        }),
      ],
      invoiceDate: '2026-07-18',
      settings,
    })

    expect(starting.invoices[0]?.applicationReference).toBe('CUSTOMER-0042')
    expect(starting.invoices[0]?.payload).toMatchObject({ Reference: 'CUSTOMER-0042' })
    expect(large.invoices[0]?.applicationReference).toBe('CUSTOMER-10000')
  })

  it('does not silently truncate a line description', () => {
    expect(() =>
      buildBillingPreview({
        batchReference: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
        entries: [entry({ description: 'x'.repeat(3_900) })],
        invoiceDate: '2026-07-18',
        settings: {
          ...settings,
          invoiceLineDescriptionTemplate: `${'prefix '.repeat(20)}{{description}}`,
        },
      }),
    ).toThrow(/No text was truncated/)
  })

  it('supports both payment term policies with month-end clamping', () => {
    expect(dueDateFor('2026-07-18', { basis: 'days-after-invoice', value: 14 })).toBe('2026-08-01')
    expect(dueDateFor('2026-01-31', { basis: 'day-of-following-month', value: 31 })).toBe(
      '2026-02-28',
    )
  })

  it('hashes semantically identical objects deterministically', () => {
    expect(stableJSON({ b: 2, a: { z: 1, y: 0 } })).toBe(stableJSON({ a: { y: 0, z: 1 }, b: 2 }))
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }))
  })
})
