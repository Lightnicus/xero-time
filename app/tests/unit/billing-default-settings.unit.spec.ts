import { describe, expect, it, vi } from 'vitest'

import { validateXeroBillingDefaultChange } from '@/globals/BillingSettings'
import {
  billingDefaultFieldErrors,
  buildRevenueAccountOptions,
  buildRevenueTaxOptions,
} from '@/lib/billing/default-options'
import { validateXeroBillingDefaults } from '@/lib/billing/default-validation'
import type { XeroReferenceDatum } from '@/payload-types'

import type { PayloadRequest } from 'payload'

const reference = (overrides: Partial<XeroReferenceDatum>): XeroReferenceDatum => ({
  code: '200',
  createdAt: '2026-07-20T00:00:00.000Z',
  fetchedAt: '2026-07-20T00:00:00.000Z',
  id: String(overrides.code ?? 'reference'),
  name: 'Sales',
  resourceType: 'account',
  sourceTenantId: 'tenant-1',
  status: 'active',
  updatedAt: '2026-07-20T00:00:00.000Z',
  ...overrides,
})

const requestWith = ({
  account,
  connected = true,
  tax,
}: {
  account?: XeroReferenceDatum
  connected?: boolean
  tax?: XeroReferenceDatum
}) => {
  const find = vi.fn(async (args: { collection: string; where?: unknown }) => {
    if (args.collection === 'xero-connections') {
      return { docs: connected ? [{ tenantId: 'tenant-1' }] : [] }
    }

    const where = JSON.stringify(args.where)
    return { docs: where.includes('tax-rate') ? (tax ? [tax] : []) : account ? [account] : [] }
  })

  return {
    find,
    req: { payload: { find } } as unknown as PayloadRequest,
  }
}

describe('frontend Xero billing defaults', () => {
  it('offers only active coded revenue, sales, and other-income accounts', () => {
    const options = buildRevenueAccountOptions([
      reference({ code: '200', name: 'Consulting', type: 'REVENUE' }),
      reference({ code: '201', name: 'Product sales', type: 'SALES' }),
      reference({ code: '202', name: 'Sundry income', type: 'OTHERINCOME' }),
      reference({ code: '203', metadata: { class: 'REVENUE' }, name: 'Classified income' }),
      reference({ code: '400', name: 'Advertising', type: 'EXPENSE' }),
      reference({ code: '204', name: 'Archived sales', status: 'archived', type: 'REVENUE' }),
      reference({ code: null, name: 'Uncoded sales', type: 'REVENUE' }),
    ])

    expect(options).toEqual([
      { label: '200 — Consulting', value: '200' },
      { label: '201 — Product sales', value: '201' },
      { label: '202 — Sundry income', value: '202' },
      { label: '203 — Classified income', value: '203' },
    ])
  })

  it('shows revenue-compatible tax names and rates while excluding expense tax', () => {
    const options = buildRevenueTaxOptions([
      reference({
        code: 'OUTPUT2',
        metadata: { canApplyToRevenue: true, displayTaxRate: 15 },
        name: 'GST on Income',
        resourceType: 'tax-rate',
      }),
      reference({
        code: 'OUTPUTZERO',
        metadata: { canApplyToRevenue: true, effectiveRate: 0 },
        name: 'Zero Rated',
        resourceType: 'tax-rate',
      }),
      reference({
        code: 'INPUT2',
        metadata: { canApplyToRevenue: false, displayTaxRate: 15 },
        name: 'GST on Expenses',
        resourceType: 'tax-rate',
      }),
    ])

    expect(options).toEqual([
      { label: 'GST on Income — OUTPUT2 (15%)', value: 'OUTPUT2' },
      { label: 'Zero Rated — OUTPUTZERO (0%)', value: 'OUTPUTZERO' },
    ])
  })

  it('does not require a tax type when line amounts use NoTax', () => {
    expect(
      billingDefaultFieldErrors({ accountCode: '200', taxRequired: false, taxType: '' }),
    ).toEqual({})
    expect(
      billingDefaultFieldErrors({ accountCode: '200', taxRequired: true, taxType: '' }),
    ).toEqual({ taxType: 'Choose a tax type.' })
  })

  it('validates both selections against the active connected tenant', async () => {
    const validAccount = reference({ code: '200', type: 'REVENUE' })
    const validTax = reference({
      code: 'OUTPUT2',
      metadata: { canApplyToRevenue: true },
      name: 'GST on Income',
      resourceType: 'tax-rate',
    })
    const { req } = requestWith({ account: validAccount, tax: validTax })

    await expect(
      validateXeroBillingDefaults(req, { accountCode: '200', taxType: 'OUTPUT2' }),
    ).resolves.toBeUndefined()

    const invalid = requestWith({
      account: validAccount,
      tax: reference({
        code: 'INPUT2',
        metadata: { canApplyToRevenue: false },
        resourceType: 'tax-rate',
      }),
    })
    await expect(
      validateXeroBillingDefaults(invalid.req, { accountCode: '200', taxType: 'INPUT2' }),
    ).rejects.toMatchObject({ code: 'invalid-billing-defaults' })
  })

  it('rejects nonblank defaults without a connected organisation', async () => {
    const { req } = requestWith({ connected: false })

    await expect(validateXeroBillingDefaults(req, { accountCode: '200' })).rejects.toMatchObject({
      code: 'invalid-billing-defaults',
    })
  })

  it('does not revalidate untouched legacy defaults on a partial global update', async () => {
    const { find, req } = requestWith({ connected: false })

    await expect(
      validateXeroBillingDefaultChange({
        context: {},
        data: { processingEnabled: true },
        global: {} as never,
        originalDoc: {
          defaultRevenueAccountCode: 'LEGACY',
          defaultTaxType: 'LEGACY-TAX',
        },
        req,
      }),
    ).resolves.toEqual({ processingEnabled: true })
    expect(find).not.toHaveBeenCalled()
  })

  it('does not mistake Payload-expanded unchanged defaults for edits', async () => {
    const { find, req } = requestWith({ connected: false })

    await expect(
      validateXeroBillingDefaultChange({
        context: {},
        data: {
          defaultRevenueAccountCode: ' LEGACY ',
          defaultTaxType: 'legacy-tax',
          processingEnabled: true,
        },
        global: {} as never,
        originalDoc: {
          defaultRevenueAccountCode: 'LEGACY',
          defaultTaxType: 'LEGACY-TAX',
        },
        req,
      }),
    ).resolves.toMatchObject({ processingEnabled: true })
    expect(find).not.toHaveBeenCalled()
  })
})
