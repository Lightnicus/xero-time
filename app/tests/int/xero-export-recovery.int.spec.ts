// @vitest-environment node

import {
  createLocalReq,
  getPayload,
  registerFirstUserOperation,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { confirmBillingPreview, createBillingPreview } from '@/lib/billing/reservation'
import { normalizeBillingFilter } from '@/lib/billing/selection'
import type { AppSession } from '@/lib/member-app/session'
import { prepareXeroQueue } from '@/lib/xero/export/maintenance'
import { processInvoiceExport } from '@/lib/xero/export/processor'
import { reconcileInvoiceExport } from '@/lib/xero/export/reconciliation'
import { persistXeroWebhook, processWebhookReceipt } from '@/lib/xero/export/webhooks'
import type { XeroConnection } from '@/payload-types'
import config from '@/payload.config'

import { FakeXeroAccountingServer } from '../fakes/xero-accounting'

const PASSWORD = 'export-recovery-password-123!'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const CONTACT_ID = '33333333-3333-4333-8333-333333333333'

let payload: Payload
let ownerSession: AppSession
let memberReq: PayloadRequest
let projectID: string
let connection: XeroConnection
let succeededExportID: string
let succeededInvoiceID: string

const clear = async (): Promise<void> => {
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

const reserveOneEntry = async (
  description: string,
  batchReference: string,
): Promise<{ entryID: string; exportID: string }> => {
  const entry = await payload.create({
    collection: 'time-entries',
    data: {
      billable: true,
      description,
      enteredHours: 1,
      enteredMinutes: 0,
      inputMode: 'duration',
      project: projectID,
      timezone: 'Pacific/Auckland',
      workDate: '2026-07-18',
    } as never,
    overrideAccess: false,
    req: memberReq,
  })
  const selection = {
    excludedEntryIDs: [],
    explicitEntryIDs: [String(entry.id)],
    filter: normalizeBillingFilter({ timezone: 'Pacific/Auckland' }),
    type: 'explicit' as const,
  }
  const preview = await createBillingPreview(ownerSession, {
    batchReference,
    invoiceDate: '2026-07-18',
    selection,
  })
  const confirmation = await confirmBillingPreview(ownerSession, {
    batchReference: preview.batchReference,
    checksum: preview.checksum,
    invoiceDate: '2026-07-18',
    requestedMode: 'background',
    selection,
  })
  const exportID = confirmation.exportIDs[0]
  if (!exportID) throw new Error('The export reservation was not created.')
  return { entryID: String(entry.id), exportID }
}

const token = () => ({ accessToken: 'fake-accounting-access', connection })

const eventBody = (invoiceID: string, eventAt: string, tenantID = TENANT_ID): string =>
  JSON.stringify({
    events: [
      {
        eventCategory: 'INVOICE',
        eventDateUtc: eventAt,
        eventType: 'UPDATE',
        resourceId: invoiceID,
        tenantId: tenantID,
      },
    ],
  })

describe.sequential('Xero export and webhook recovery', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    await clear()
    const anonymousReq = await createLocalReq({}, payload)
    const bootstrap = await registerFirstUserOperation({
      collection: payload.collections.users,
      data: {
        active: true,
        displayName: 'Recovery Owner',
        email: 'recovery-owner@example.test',
        password: PASSWORD,
        role: 'owner',
        timezone: 'Pacific/Auckland',
      } as never,
      req: anonymousReq,
    })
    if (!bootstrap.user) throw new Error('Owner bootstrap failed.')
    const ownerReq = await createLocalReq({ user: bootstrap.user }, payload)
    ownerSession = { payload, req: ownerReq, user: bootstrap.user }
    const member = await payload.create({
      collection: 'users',
      data: {
        _verified: true,
        active: true,
        displayName: 'Recovery Member',
        email: 'recovery-member@example.test',
        password: PASSWORD,
        role: 'member',
        timezone: 'Pacific/Auckland',
      },
      overrideAccess: false,
      req: ownerReq,
    })
    memberReq = await createLocalReq({ user: member }, payload)
    connection = await payload.create({
      collection: 'xero-connections',
      data: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        grantedScopes: [
          'offline_access',
          'accounting.invoices',
          'accounting.contacts',
          'accounting.settings.read',
        ],
        initiatedBy: bootstrap.user.id,
        lastHealthCheckAt: new Date().toISOString(),
        singletonKey: 'business-accounting',
        status: 'connected',
        tenantId: TENANT_ID,
        tenantName: 'Recovery Demo Company',
        tenantType: 'ORGANISATION',
        tokenVersion: 1,
      },
      overrideAccess: true,
      req: ownerReq,
      showHiddenFields: true,
    })
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
        data: { ...reference, fetchedAt, sourceTenantId: TENANT_ID },
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
        processingEnabled: true,
        waitForResultEnabled: true,
        xeroExportMode: 'background',
      },
      overrideAccess: true,
      req: ownerReq,
    })
    const customer = await payload.create({
      collection: 'customers',
      data: {
        currency: 'NZD',
        name: 'Recovery Customer',
        status: 'active',
        xeroContactId: CONTACT_ID,
        xeroContactNameSnapshot: 'Recovery Customer',
        xeroLastValidatedAt: new Date().toISOString(),
        xeroLinkedAt: new Date().toISOString(),
        xeroLinkedBy: bootstrap.user.id,
        xeroMappingStatus: 'active',
      },
      overrideAccess: true,
      req: ownerReq,
    })
    const project = await payload.create({
      collection: 'projects',
      data: {
        billableByDefault: true,
        code: 'RECOVERY',
        currency: 'NZD',
        customer: customer.id,
        hourlyRateScaled: 1_500_000,
        name: 'Recovery Project',
        status: 'active',
      },
      overrideAccess: false,
      req: ownerReq,
    })
    projectID = String(project.id)
  }, 60_000)

  afterAll(async () => {
    if (!payload) return
    await clear()
    await payload.destroy()
  })

  it('reconciles a response-lost creation to exactly one Xero invoice', async () => {
    const reserved = await reserveOneEntry(
      'Ambiguous response recovery',
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    )
    const fake = new FakeXeroAccountingServer()
    fake.enqueue('post', 'ambiguous-create')

    await expect(
      processInvoiceExport(ownerSession.req, reserved.exportID, {
        client: fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ state: 'reconciling' })
    expect(fake.invoiceCount()).toBe(1)

    const reconciliation = await reconcileInvoiceExport(ownerSession.req, reserved.exportID, {
      client: fake.client(),
      token: token(),
    })
    const reconciledDocument = await payload.findByID({
      collection: 'invoice-exports',
      depth: 0,
      id: reserved.exportID,
      overrideAccess: true,
    })
    expect({
      errorCode: reconciledDocument.lastErrorCode,
      errorMessage: reconciledDocument.lastErrorMessage,
      result: reconciliation,
    }).toEqual({
      errorCode: null,
      errorMessage: null,
      result: { state: 'succeeded' },
    })

    const [entry, exportDocument] = await Promise.all([
      payload.findByID({
        collection: 'time-entries',
        depth: 0,
        id: reserved.entryID,
        overrideAccess: true,
      }),
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: reserved.exportID,
        overrideAccess: true,
      }),
    ])
    expect(entry.billingStatus).toBe('exported')
    expect(exportDocument).toMatchObject({ state: 'succeeded', remoteStatus: 'DRAFT' })
    expect(fake.invoiceCount()).toBe(1)
    expect(fake.requests.filter((request) => request.operation === 'post')).toHaveLength(1)
    succeededExportID = reserved.exportID
    succeededInvoiceID = exportDocument.xeroInvoiceId as string
  })

  it('routes an unknown exception after the send marker to reconciliation', async () => {
    const reserved = await reserveOneEntry(
      'Unknown transport failure recovery',
      'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
    )
    const fakeClient = new FakeXeroAccountingServer().client()
    fakeClient.accountingPost = async () => {
      throw new Error('simulated transport exception')
    }

    await expect(
      processInvoiceExport(ownerSession.req, reserved.exportID, {
        client: fakeClient,
        token: token(),
      }),
    ).resolves.toEqual({ state: 'reconciling' })
    const [exportDocument, attempts] = await Promise.all([
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: reserved.exportID,
        overrideAccess: true,
      }),
      payload.find({
        collection: 'xero-attempts',
        depth: 0,
        overrideAccess: true,
        where: { invoiceExport: { equals: reserved.exportID } },
      }),
    ])
    expect(exportDocument.state).toBe('reconciling')
    expect(attempts.docs[0]).toMatchObject({ requestMayHaveBeenSent: true, result: 'ambiguous' })
  })

  it('releases a definite validation failure but keeps its immutable history', async () => {
    const reserved = await reserveOneEntry(
      'Definite validation failure',
      'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
    )
    const fake = new FakeXeroAccountingServer()
    fake.enqueue('post', 'validation')

    await expect(
      processInvoiceExport(ownerSession.req, reserved.exportID, {
        client: fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ state: 'action-required' })
    const [entry, exportDocument, allocations] = await Promise.all([
      payload.findByID({
        collection: 'time-entries',
        depth: 0,
        id: reserved.entryID,
        overrideAccess: true,
      }),
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: reserved.exportID,
        overrideAccess: true,
      }),
      payload.find({
        collection: 'invoice-export-entries',
        depth: 0,
        overrideAccess: true,
        where: { invoiceExport: { equals: reserved.exportID } },
      }),
    ])
    expect(entry).toMatchObject({ billingStatus: 'unbilled', currentExport: null })
    expect(exportDocument).toMatchObject({ state: 'action-required' })
    expect(allocations.docs).toHaveLength(1)
  })

  it('recovers stale workers differently before and after the send boundary', async () => {
    const beforeSend = await reserveOneEntry(
      'Stale before send',
      'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
    )
    const beforeAttempt = await payload.find({
      collection: 'xero-attempts',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { invoiceExport: { equals: beforeSend.exportID } },
    })
    await Promise.all([
      payload.update({
        collection: 'invoice-exports',
        id: beforeSend.exportID,
        data: {
          processingLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          processingLeaseId: 'expired-before-send',
          state: 'processing',
        },
        overrideAccess: true,
      }),
      payload.update({
        collection: 'xero-attempts',
        id: beforeAttempt.docs[0]?.id as string,
        data: { requestMayHaveBeenSent: false },
        overrideAccess: true,
      }),
    ])
    const beforeResult = await prepareXeroQueue(payload, ownerSession.req)
    expect(beforeResult.recovered).toBeGreaterThanOrEqual(1)
    await expect(
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: beforeSend.exportID,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ lastErrorCode: 'stale-worker-before-send', state: 'queued' })

    const afterSend = await reserveOneEntry(
      'Stale after send',
      'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE',
    )
    const afterAttempt = await payload.find({
      collection: 'xero-attempts',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { invoiceExport: { equals: afterSend.exportID } },
    })
    await Promise.all([
      payload.update({
        collection: 'invoice-exports',
        id: afterSend.exportID,
        data: {
          processingLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          processingLeaseId: 'expired-after-send',
          state: 'processing',
        },
        overrideAccess: true,
      }),
      payload.update({
        collection: 'xero-attempts',
        id: afterAttempt.docs[0]?.id as string,
        data: {
          requestMayHaveBeenSent: true,
          requestStartedAt: new Date(Date.now() - 60_000).toISOString(),
        },
        overrideAccess: true,
      }),
    ])
    const afterResult = await prepareXeroQueue(payload, ownerSession.req)
    expect(afterResult.recovered).toBeGreaterThanOrEqual(1)
    await expect(
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: afterSend.exportID,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ lastErrorCode: 'stale-worker-ambiguous', state: 'reconciling' })
  })

  it('deduplicates, leases, retries, and safely processes out-of-order webhooks', async () => {
    const eventAt = '2026-07-18T04:00:00.000Z'
    const duplicateEnvelope = JSON.stringify({
      events: [
        JSON.parse(eventBody(succeededInvoiceID, eventAt)).events[0],
        JSON.parse(eventBody(succeededInvoiceID, eventAt)).events[0],
      ],
    })
    await expect(persistXeroWebhook(payload, duplicateEnvelope)).resolves.toEqual({
      duplicateCount: 1,
      receiptCount: 1,
    })
    await expect(persistXeroWebhook(payload, duplicateEnvelope)).resolves.toEqual({
      duplicateCount: 2,
      receiptCount: 0,
    })

    const originalReceipt = await payload.find({
      collection: 'xero-webhook-receipts',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { eventAt: { equals: eventAt } },
    })
    const refresh = vi.fn(async () => ({ remoteStatus: 'DRAFT', state: 'succeeded' }))
    const concurrent = await Promise.all([
      processWebhookReceipt(ownerSession.req, String(originalReceipt.docs[0]?.id), { refresh }),
      processWebhookReceipt(ownerSession.req, String(originalReceipt.docs[0]?.id), { refresh }),
    ])
    expect(concurrent.map((result) => result.state).sort()).toEqual([
      'already-processed',
      'processed',
    ])
    expect(refresh).toHaveBeenCalledTimes(1)

    const newerAt = '2026-07-18T06:00:00.000Z'
    const olderAt = '2026-07-18T02:00:00.000Z'
    await persistXeroWebhook(payload, eventBody(succeededInvoiceID, newerAt))
    await persistXeroWebhook(payload, eventBody(succeededInvoiceID, olderAt))
    const outOfOrder = await payload.find({
      collection: 'xero-webhook-receipts',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { eventAt: { in: [newerAt, olderAt] } },
    })
    const newer = outOfOrder.docs.find((receipt) => receipt.eventAt === newerAt)
    const older = outOfOrder.docs.find((receipt) => receipt.eventAt === olderAt)
    await processWebhookReceipt(ownerSession.req, String(newer?.id), { refresh })
    await processWebhookReceipt(ownerSession.req, String(older?.id), { refresh })
    expect(refresh).toHaveBeenNthCalledWith(2, ownerSession.req, succeededExportID)
    expect(refresh).toHaveBeenNthCalledWith(3, ownerSession.req, succeededExportID)

    const retryAt = '2026-07-18T08:00:00.000Z'
    await persistXeroWebhook(payload, eventBody(succeededInvoiceID, retryAt))
    const retryReceipt = await payload.find({
      collection: 'xero-webhook-receipts',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { eventAt: { equals: retryAt } },
    })
    const failOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary refresh failure'))
      .mockResolvedValue({ remoteStatus: 'DRAFT', state: 'succeeded' })
    await expect(
      processWebhookReceipt(ownerSession.req, String(retryReceipt.docs[0]?.id), {
        refresh: failOnce,
      }),
    ).rejects.toThrow('temporary refresh failure')
    await expect(
      processWebhookReceipt(ownerSession.req, String(retryReceipt.docs[0]?.id), {
        refresh: failOnce,
      }),
    ).resolves.toEqual({ state: 'processed' })
    await expect(
      payload.findByID({
        collection: 'xero-webhook-receipts',
        depth: 0,
        id: retryReceipt.docs[0]?.id as string,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ retryCount: 1, status: 'processed' })

    const wrongTenantAt = '2026-07-18T10:00:00.000Z'
    await persistXeroWebhook(
      payload,
      eventBody(succeededInvoiceID, wrongTenantAt, '99999999-9999-4999-8999-999999999999'),
    )
    const wrongTenant = await payload.find({
      collection: 'xero-webhook-receipts',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { eventAt: { equals: wrongTenantAt } },
    })
    await expect(
      processWebhookReceipt(ownerSession.req, String(wrongTenant.docs[0]?.id), { refresh }),
    ).resolves.toEqual({ state: 'ignored' })
    await expect(
      payload.findByID({
        collection: 'xero-webhook-receipts',
        depth: 0,
        id: wrongTenant.docs[0]?.id as string,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ failureCode: 'wrong-tenant', status: 'ignored' })
  })
})
