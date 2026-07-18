// @vitest-environment node

import { performance } from 'node:perf_hooks'

import { describe, expect, it } from 'vitest'

import type { EligibleBillingEntry } from '@/lib/billing/contracts'
import { dispatchPreparingExports } from '@/lib/billing/dispatch'
import { getBillingEligibility } from '@/lib/billing/eligibility'
import { buildBillingPreview } from '@/lib/billing/preview'
import { listMyTimeEntries } from '@/lib/member-app/data'
import type { AppSession } from '@/lib/member-app/session'

const MAX_LOCAL_MS = 10_000

const measured = async <T>(
  callback: () => Promise<T> | T,
): Promise<{ elapsed: number; value: T }> => {
  const started = performance.now()
  const value = await callback()
  return { elapsed: performance.now() - started, value }
}

describe('bounded core performance smoke', () => {
  it('summarizes and paginates 20,000 member entries within a bounded time', async () => {
    const entries = Array.from({ length: 20_000 }, (_, index) => ({
      billable: index % 4 !== 0,
      billingStatus: index % 5 === 0 ? 'exported' : 'unbilled',
      createdAt: '2026-07-18T00:00:00.000Z',
      durationSeconds: 60 * ((index % 120) + 1),
      id: `entry-${index}`,
      workDate: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
    }))
    const fakePayload = {
      find: async (args: { limit?: number; pagination?: boolean }) =>
        args.pagination === false
          ? { docs: entries }
          : {
              docs: entries.slice(0, args.limit ?? 25),
              hasNextPage: true,
              hasPrevPage: false,
              page: 1,
              totalDocs: entries.length,
              totalPages: Math.ceil(entries.length / (args.limit ?? 25)),
            },
    }
    const session = {
      payload: fakePayload,
      req: {},
      user: { id: 'member-1' },
    } as unknown as AppSession
    const result = await measured(() => listMyTimeEntries(session, 1))

    expect(result.value.entries).toHaveLength(25)
    expect(result.value.summary.entryCount).toBe(20_000)
    expect(result.value.summary.durationSeconds).toBeGreaterThan(0)
    expect(result.elapsed).toBeLessThan(MAX_LOCAL_MS)
  })

  it('resolves 5,000 eligible billing rows and builds one line per entry', async () => {
    const customer = {
      currency: 'NZD',
      id: 'customer-1',
      name: 'Performance Customer',
      status: 'active',
      xeroContactId: '11111111-1111-4111-8111-111111111111',
      xeroContactNameSnapshot: 'Performance Customer',
      xeroLastValidatedAt: new Date().toISOString(),
      xeroMappingStatus: 'active',
    }
    const project = {
      code: 'PERF',
      currency: 'NZD',
      customer: customer.id,
      id: 'project-1',
      name: 'Performance Project',
      status: 'active',
    }
    const user = { active: true, displayName: 'Performance Member', id: 'member-1' }
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      billable: true,
      billingStatus: 'unbilled',
      currencySnapshot: 'NZD',
      customer: customer.id,
      customerNameSnapshot: customer.name,
      description: `Representative entry ${index}`,
      durationSeconds: 60 * ((index % 120) + 1),
      id: `entry-${index}`,
      owner: user.id,
      project: project.id,
      projectCodeSnapshot: project.code,
      projectNameSnapshot: project.name,
      rateSnapshotScaled: 1_500_000,
      timezone: 'Pacific/Auckland',
      updatedAt: '2026-07-18T00:00:00.000Z',
      workDate: '2026-07-18',
    }))
    const references = [
      { code: '200', resourceType: 'account', status: 'active' },
      {
        code: 'OUTPUT2',
        metadata: { effectiveRate: 15 },
        resourceType: 'tax-rate',
        status: 'active',
      },
      { code: 'NZD', resourceType: 'currency', status: 'active' },
      { code: 'CreateDraftInvoice', resourceType: 'organisation-action', status: 'active' },
    ]
    const fakePayload = {
      find: async (args: {
        collection: string
        limit?: number
        page?: number
        pagination?: boolean
      }) => {
        if (args.collection === 'time-entries') {
          const page = args.page ?? 1
          const limit = args.limit ?? 500
          const docs = entries.slice((page - 1) * limit, page * limit)
          return { docs, hasNextPage: page * limit < entries.length }
        }
        if (args.collection === 'customers') return { docs: [customer] }
        if (args.collection === 'projects') return { docs: [project] }
        if (args.collection === 'users') return { docs: [user] }
        if (args.collection === 'xero-connections') {
          return {
            docs: [
              {
                singletonKey: 'business-accounting',
                status: 'connected',
                tenantId: 'tenant-1',
              },
            ],
          }
        }
        if (args.collection === 'xero-reference-data') return { docs: references }
        return { docs: [] }
      },
      findGlobal: async () => ({
        acceptingNewExports: true,
        defaultRevenueAccountCode: '200',
        defaultTaxType: 'OUTPUT2',
        invoiceLineDescriptionTemplate: '{{workDate}} · {{projectCode}} · {{description}}',
        invoiceReferencePrefix: 'TIME-',
        lineAmountType: 'Exclusive',
        paymentTerms: { basis: 'days-after-invoice', value: 14 },
      }),
    }
    const session = {
      payload: fakePayload,
      req: {},
      user: { active: true, collection: 'users', id: 'biller-1', role: 'biller' },
    } as unknown as AppSession
    const eligibility = await measured(() => getBillingEligibility(session))
    expect(eligibility.value.eligible).toHaveLength(5_000)
    expect(eligibility.elapsed).toBeLessThan(MAX_LOCAL_MS)

    const previewEntries = eligibility.value.eligible.slice(0, 1_000) as EligibleBillingEntry[]
    const preview = await measured(() =>
      buildBillingPreview({
        batchReference: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
        entries: previewEntries,
        invoiceDate: '2026-07-18',
        settings: eligibility.value.settings,
      }),
    )
    expect(preview.value.invoices[0]?.lines).toHaveLength(1_000)
    expect(preview.elapsed).toBeLessThan(MAX_LOCAL_MS)
  })

  it('caps each dispatcher sweep at 100 exports', async () => {
    let requestedLimit = 0
    let inspected = 0
    const exportModel = {
      findOne: async () => {
        inspected += 1
        return null
      },
    }
    const fakePayload = {
      db: { collections: { 'invoice-exports': exportModel } },
      find: async (args: { limit: number }) => {
        requestedLimit = args.limit
        return {
          docs: Array.from({ length: args.limit }, (_, index) => ({ id: `export-${index}` })),
        }
      },
    }
    const result = await measured(() =>
      dispatchPreparingExports(fakePayload as never, undefined, 50_000),
    )

    expect(requestedLimit).toBe(100)
    expect(inspected).toBe(100)
    expect(result.elapsed).toBeLessThan(MAX_LOCAL_MS)
  })
})
