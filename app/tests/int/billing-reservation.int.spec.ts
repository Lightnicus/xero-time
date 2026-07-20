// @vitest-environment node

import {
  createLocalReq,
  getPayload,
  registerFirstUserOperation,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TIME_ENTRY_BILLING_MUTATION_CONTEXT } from '@/collections/TimeEntries'
import { getBillingEligibility } from '@/lib/billing/eligibility'
import { cancelInvoiceExport, releaseInvoiceExport } from '@/lib/billing/export-actions'
import { createBillingPreview, confirmBillingPreview } from '@/lib/billing/reservation'
import { normalizeBillingFilter } from '@/lib/billing/selection'
import type { AppSession } from '@/lib/member-app/session'
import config from '@/payload.config'

const PASSWORD = 'billing-integration-password!'
let payload: Payload
let ownerSession: AppSession
let billerSession: AppSession
let customerID: string
let remainingEntryID: string
const entryIDs: string[] = []

const clear = async () => {
  for (const slug of [
    'payload-jobs',
    'audit-events',
    'release-actions',
    'xero-webhook-receipts',
    'xero-contact-operations',
    'xero-attempts',
    'invoice-export-entries',
    'invoice-exports',
    'export-batches',
    'xero-reference-data',
    'xero-oauth-states',
    'xero-connections',
    'time-entries',
    'projects',
    'customers',
    'invitations',
    'external-auth-sessions',
    'auth-identities',
    'users',
  ]) {
    await payload.db.collections[slug]?.deleteMany({})
    await payload.db.versions[slug]?.deleteMany({})
  }
  await payload.db.connection.db?.collection('application_bootstrap_locks').deleteMany({})
}

const reqFor = (user: unknown): Promise<PayloadRequest> =>
  createLocalReq({ user: user as never }, payload)

describe.sequential('billing reservation saga', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    await clear()
    const anonymousReq = await createLocalReq({}, payload)
    const bootstrapped = await registerFirstUserOperation({
      collection: payload.collections.users,
      data: {
        active: true,
        displayName: 'Billing Owner',
        email: 'billing-owner@example.test',
        password: PASSWORD,
        role: 'owner',
        timezone: 'Pacific/Auckland',
      } as never,
      req: anonymousReq,
    })
    const owner = bootstrapped.user
    if (!owner) throw new Error('Owner bootstrap failed.')
    const ownerReq = await reqFor(owner)
    const biller = await payload.create({
      collection: 'users',
      data: {
        _verified: true,
        active: true,
        displayName: 'Billing Operator',
        email: 'billing-operator@example.test',
        password: PASSWORD,
        role: 'biller',
        timezone: 'Pacific/Auckland',
      },
      overrideAccess: false,
      req: ownerReq,
    })
    const member = await payload.create({
      collection: 'users',
      data: {
        _verified: true,
        active: true,
        displayName: 'Time Member',
        email: 'billing-member@example.test',
        password: PASSWORD,
        role: 'member',
        timezone: 'Pacific/Auckland',
      },
      overrideAccess: false,
      req: ownerReq,
    })
    const billerReq = await reqFor(biller)
    const memberReq = await reqFor(member)
    ownerSession = { payload, req: ownerReq, user: owner }
    billerSession = { payload, req: billerReq, user: biller }

    await payload.create({
      collection: 'xero-connections',
      data: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        grantedScopes: [
          'offline_access',
          'accounting.invoices',
          'accounting.contacts',
          'accounting.settings.read',
        ],
        initiatedBy: owner.id,
        singletonKey: 'business-accounting',
        status: 'connected',
        tenantId: '22222222-2222-4222-8222-222222222222',
        tenantName: 'Billing Demo Company',
        tenantType: 'ORGANISATION',
        tokenVersion: 1,
      },
      overrideAccess: true,
      req: ownerReq,
    })
    const tenantID = '22222222-2222-4222-8222-222222222222'
    const fetchedAt = new Date().toISOString()
    for (const reference of [
      {
        code: '200',
        name: 'Sales',
        resourceType: 'account',
        status: 'active',
        type: 'REVENUE',
        xeroId: 'account-200',
      },
      {
        code: 'OUTPUT2',
        metadata: { canApplyToRevenue: true, effectiveRate: 15 },
        name: 'GST on Income',
        resourceType: 'tax-rate',
        status: 'active',
        xeroId: 'OUTPUT2',
      },
      {
        code: 'NZD',
        name: 'New Zealand Dollar',
        resourceType: 'currency',
        status: 'active',
        xeroId: 'NZD',
      },
      {
        code: 'CreateDraftInvoice',
        name: 'CreateDraftInvoice',
        resourceType: 'organisation-action',
        status: 'active',
        xeroId: 'CreateDraftInvoice',
      },
    ] as const) {
      await payload.create({
        collection: 'xero-reference-data',
        data: { ...reference, fetchedAt, sourceTenantId: tenantID },
        overrideAccess: true,
        req: ownerReq,
      })
    }
    await payload.updateGlobal({
      slug: 'billing-settings',
      data: {
        acceptingNewExports: true,
        defaultRevenueAccountCode: '200',
        defaultTaxType: 'OUTPUT2',
        invoiceLineDescriptionTemplate: '{{workDate}} · {{projectCode}} · {{description}}',
        processingEnabled: false,
        waitForResultEnabled: false,
        xeroExportMode: 'background',
      },
      overrideAccess: true,
      req: ownerReq,
    })
    const customer = await payload.create({
      collection: 'customers',
      data: {
        currency: 'NZD',
        invoiceReferenceCode: 'MAPPED',
        invoiceReferenceStartNumber: 1,
        name: 'Mapped Billing Customer',
        status: 'active',
        xeroContactId: '33333333-3333-4333-8333-333333333333',
        xeroContactNameSnapshot: 'Mapped Billing Customer',
        xeroLastValidatedAt: new Date().toISOString(),
        xeroLinkedAt: new Date().toISOString(),
        xeroLinkedBy: owner.id,
        xeroMappingStatus: 'active',
      },
      overrideAccess: true,
      req: ownerReq,
    })
    customerID = String(customer.id)
    const project = await payload.create({
      collection: 'projects',
      data: {
        billableByDefault: true,
        code: 'BILLING',
        currency: 'NZD',
        customer: customer.id,
        hourlyRateScaled: 1_500_000,
        name: 'Billing Project',
        status: 'active',
      },
      overrideAccess: false,
      req: ownerReq,
    })
    for (const [description, minutes] of [
      ['First complete line', 1],
      ['Second complete line', 59],
    ] as const) {
      const timeEntry = await payload.create({
        collection: 'time-entries',
        data: {
          billable: true,
          description,
          enteredHours: 0,
          enteredMinutes: minutes,
          inputMode: 'duration',
          owner: member.id,
          project: project.id,
          timezone: 'Pacific/Auckland',
          workDate: '2026-07-18',
        } as never,
        overrideAccess: false,
        req: memberReq,
      })
      entryIDs.push(String(timeEntry.id))
    }
  }, 60_000)

  afterAll(async () => {
    if (!payload) return
    await clear()
    await payload.destroy()
  })

  it('blocks billing until the customer has a valid invoice-reference code', async () => {
    await payload.update({
      collection: 'customers',
      data: { invoiceReferenceCode: null },
      id: customerID,
      overrideAccess: true,
      req: ownerSession.req,
    })

    const eligibility = await getBillingEligibility(
      billerSession,
      { timezone: 'Pacific/Auckland' },
      { entryIDs },
    )
    expect(eligibility.eligible).toHaveLength(0)
    expect(
      eligibility.blocked.every((entry) =>
        entry.blockers.some(
          (item) =>
            item.code === 'missing-customer-reference' &&
            item.remediationHref ===
              `/app/settings/customers#customer-reference-${encodeURIComponent(customerID)}`,
        ),
      ),
    ).toBe(true)

    await payload.update({
      collection: 'customers',
      data: { invoiceReferenceCode: 'MAPPED', invoiceReferenceStartNumber: 1 },
      id: customerID,
      overrideAccess: true,
      req: ownerSession.req,
    })
  })

  it('atomically saves immutable one-entry/one-line snapshots before job dispatch', async () => {
    const selection = {
      excludedEntryIDs: [],
      explicitEntryIDs: entryIDs,
      filter: normalizeBillingFilter({ timezone: 'Pacific/Auckland' }),
      type: 'explicit' as const,
    }
    const preview = await createBillingPreview(billerSession, {
      batchReference: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
      invoiceDate: '2026-07-18',
      selection,
    })
    expect(preview.invoices).toHaveLength(1)
    expect(preview.invoices[0]?.lines).toHaveLength(2)
    expect(preview.invoices[0]?.applicationReference).toBe('MAPPED-0001')
    const result = await confirmBillingPreview(billerSession, {
      batchReference: preview.batchReference,
      checksum: preview.checksum,
      invoiceDate: '2026-07-18',
      requestedMode: 'background',
      selection,
    })
    expect(result.exportIDs).toHaveLength(1)
    const exportID = result.exportIDs[0] as string
    const invoiceExport = await payload.findByID({
      collection: 'invoice-exports',
      depth: 0,
      id: exportID,
      overrideAccess: true,
    })
    const entries = await payload.find({
      collection: 'time-entries',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { id: { in: entryIDs } },
    })
    const allocations = await payload.find({
      collection: 'invoice-export-entries',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { invoiceExport: { equals: exportID } },
    })
    const attempts = await payload.find({
      collection: 'xero-attempts',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { invoiceExport: { equals: exportID } },
    })
    const jobs = await payload.find({
      collection: 'payload-jobs',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { taskSlug: { equals: 'create-xero-invoice' } },
    })
    expect(entries.docs.every((entry) => entry.billingStatus === 'reserved')).toBe(true)
    expect(invoiceExport).toMatchObject({
      applicationReference: 'MAPPED-0001',
      customerReferenceCode: 'MAPPED',
      customerReferenceSequence: 1,
    })
    expect(entries.docs.every((entry) => String(entry.currentExport) === exportID)).toBe(true)
    expect(allocations.docs).toHaveLength(2)
    expect(new Set(allocations.docs.map((line) => String(line.timeEntry)))).toEqual(
      new Set(entryIDs),
    )
    expect(attempts.docs).toHaveLength(1)
    expect(jobs.docs).toHaveLength(1)
    await expect(
      payload.update({
        collection: 'invoice-export-entries',
        id: allocations.docs[0]?.id as string,
        data: { description: 'mutated snapshot' },
        overrideAccess: false,
        req: ownerSession.req,
      }),
    ).rejects.toMatchObject({ status: 403 })

    await cancelInvoiceExport(billerSession, {
      exportID,
      reason: 'Integration test cancellation before any worker send.',
    })
    const released = await payload.find({
      collection: 'time-entries',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { id: { in: entryIDs } },
    })
    expect(released.docs.every((entry) => entry.billingStatus === 'unbilled')).toBe(true)
    await expect(
      payload.update({
        collection: 'customers',
        data: { invoiceReferenceCode: 'RENAMED' },
        id: customerID,
        overrideAccess: true,
        req: ownerSession.req,
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('allows only one concurrent same-customer preview to claim the next number', async () => {
    const leftSelection = {
      excludedEntryIDs: [],
      explicitEntryIDs: [entryIDs[0] as string],
      filter: normalizeBillingFilter({ timezone: 'Pacific/Auckland' }),
      type: 'explicit' as const,
    }
    const rightSelection = {
      ...leftSelection,
      explicitEntryIDs: [entryIDs[1] as string],
    }
    const left = await createBillingPreview(billerSession, {
      batchReference: '11111111-1111-4111-8111-111111111111',
      invoiceDate: '2026-07-19',
      selection: leftSelection,
    })
    const right = await createBillingPreview(billerSession, {
      batchReference: '22222222-2222-4222-8222-222222222222',
      invoiceDate: '2026-07-19',
      selection: rightSelection,
    })
    const confirmations = await Promise.allSettled([
      confirmBillingPreview(billerSession, {
        batchReference: left.batchReference,
        checksum: left.checksum,
        invoiceDate: '2026-07-19',
        requestedMode: 'background',
        selection: leftSelection,
      }),
      confirmBillingPreview(billerSession, {
        batchReference: right.batchReference,
        checksum: right.checksum,
        invoiceDate: '2026-07-19',
        requestedMode: 'background',
        selection: rightSelection,
      }),
    ])
    expect(confirmations.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = confirmations.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]?.reason)).toMatch(/billing data changed after preview/i)
    const claimedCustomer = await payload.findByID({
      collection: 'customers',
      depth: 0,
      id: customerID,
      overrideAccess: true,
    })
    expect(claimedCustomer.lastInvoiceReferenceSequence).toBe(2)
    expect(left.invoices[0]?.applicationReference).toBe('MAPPED-0002')
    expect(right.invoices[0]?.applicationReference).toBe('MAPPED-0002')
    const entries = await payload.find({
      collection: 'time-entries',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      where: { id: { in: entryIDs } },
    })
    const statusByID = new Map(entries.docs.map((entry) => [String(entry.id), entry.billingStatus]))
    expect([...statusByID.values()].filter((status) => status === 'reserved')).toHaveLength(1)
    expect([...statusByID.values()].filter((status) => status === 'unbilled')).toHaveLength(1)
    remainingEntryID = [...statusByID].find(([, status]) => status === 'unbilled')?.[0] ?? ''
    expect(remainingEntryID).not.toBe('')
  })

  it('releases a verified voided invoice once and preserves rebill lineage', async () => {
    const selected = [remainingEntryID]
    const selection = {
      excludedEntryIDs: [],
      explicitEntryIDs: selected,
      filter: normalizeBillingFilter({ timezone: 'Pacific/Auckland' }),
      type: 'explicit' as const,
    }
    const preview = await createBillingPreview(billerSession, {
      batchReference: '33333333-3333-4333-8333-333333333333',
      invoiceDate: '2026-07-20',
      selection,
    })
    expect(preview.invoices[0]?.applicationReference).toBe('MAPPED-0003')
    const reservation = await confirmBillingPreview(billerSession, {
      batchReference: preview.batchReference,
      checksum: preview.checksum,
      invoiceDate: '2026-07-20',
      requestedMode: 'background',
      selection,
    })
    const originalExportID = reservation.exportIDs[0]
    if (!originalExportID) throw new Error('The original export was not created.')
    const remoteInvoiceID = '77777777-7777-4777-8777-777777777777'
    const exportedAt = new Date().toISOString()
    await payload.update({
      collection: 'time-entries',
      context: { [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'export' },
      data: { billingStatus: 'exported', exportedAt },
      depth: 0,
      id: selected[0] as string,
      overrideAccess: true,
      req: ownerSession.req,
    })
    const originalExport = await payload.update({
      collection: 'invoice-exports',
      data: {
        dispatchState: 'complete',
        remoteStatus: 'VOIDED',
        state: 'succeeded',
        xeroInvoiceId: remoteInvoiceID,
        xeroInvoiceNumber: 'INV-VOID-1',
      },
      depth: 0,
      id: originalExportID,
      overrideAccess: true,
      req: ownerSession.req,
    })
    const fetchRemote = async () => ({
      remote: {
        contactID: '33333333-3333-4333-8333-333333333333',
        currency: 'NZD',
        invoiceID: remoteInvoiceID,
        lineItemIDs: ['88888888-8888-4888-8888-888888888888'],
        lineItems: [{}],
        reference: originalExport.applicationReference,
        status: 'VOIDED',
      },
      response: { data: {} } as never,
    })
    const releaseInput = {
      confirmation: originalExport.applicationReference,
      exportID: originalExportID,
      reason: 'Release the remotely voided integration invoice for rebilling.',
    }
    const ownerTwo = { ...ownerSession, req: await reqFor(ownerSession.user) }
    const releases = await Promise.allSettled([
      releaseInvoiceExport(ownerSession, releaseInput, { fetchRemote }),
      releaseInvoiceExport(ownerTwo, releaseInput, { fetchRemote }),
    ])
    expect(releases.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(releases.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const releasedEntry = await payload.findByID({
      collection: 'time-entries',
      depth: 0,
      id: selected[0] as string,
      overrideAccess: true,
    })
    expect(releasedEntry).toMatchObject({ billingStatus: 'unbilled', currentExport: null })
    const releasesSaved = await payload.find({
      collection: 'release-actions',
      depth: 0,
      overrideAccess: true,
      where: { sourceExport: { equals: originalExportID } },
    })
    expect(releasesSaved.docs).toHaveLength(1)

    const rebillPreview = await createBillingPreview(billerSession, {
      batchReference: '99999999-9999-4999-8999-999999999999',
      invoiceDate: '2026-07-21',
      selection,
    })
    expect(rebillPreview.invoices[0]?.applicationReference).toBe('MAPPED-0004')
    const rebill = await confirmBillingPreview(billerSession, {
      batchReference: rebillPreview.batchReference,
      checksum: rebillPreview.checksum,
      invoiceDate: '2026-07-21',
      requestedMode: 'background',
      selection,
    })
    const replacement = await payload.findByID({
      collection: 'invoice-exports',
      depth: 0,
      id: rebill.exportIDs[0] as string,
      overrideAccess: true,
    })
    expect(String(replacement.rebillOf)).toBe(originalExportID)
    const preservedOriginal = await payload.findByID({
      collection: 'invoice-exports',
      depth: 0,
      id: originalExportID,
      overrideAccess: true,
    })
    expect(preservedOriginal).toMatchObject({
      applicationReference: originalExport.applicationReference,
      state: 'released',
      xeroInvoiceId: remoteInvoiceID,
    })
  })

  it('denies billing collections to members through ordinary APIs', async () => {
    const member = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { role: { equals: 'member' } },
    })
    const memberReq = await reqFor(member.docs[0])
    await expect(
      payload.find({ collection: 'invoice-exports', overrideAccess: false, req: memberReq }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.find({ collection: 'xero-attempts', overrideAccess: false, req: memberReq }),
    ).rejects.toMatchObject({ status: 403 })
  })
})
