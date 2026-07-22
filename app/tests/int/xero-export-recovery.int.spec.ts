// @vitest-environment node

import {
  createLocalReq,
  getPayload,
  registerFirstUserOperation,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { deleteDraftInvoiceAndRelease, releaseInvoiceExport } from '@/lib/billing/export-actions'
import { confirmBillingPreview, createBillingPreview } from '@/lib/billing/reservation'
import { normalizeBillingFilter } from '@/lib/billing/selection'
import { isRecord, relationshipID } from '@/lib/domain/validation'
import type { AppSession } from '@/lib/member-app/session'
import { prepareXeroQueue } from '@/lib/xero/export/maintenance'
import {
  parseRemoteInvoices,
  processInvoiceExport,
  remoteDerivedValuesHash,
} from '@/lib/xero/export/processor'
import {
  fetchRemoteInvoiceForExport,
  reconcileInvoiceExport,
  refreshInvoiceExportStatus,
} from '@/lib/xero/export/reconciliation'
import { persistXeroWebhook, processWebhookReceipt } from '@/lib/xero/export/webhooks'
import type { InvoiceExport, XeroConnection } from '@/payload-types'
import config from '@/payload.config'

import { FakeXeroAccountingServer } from '../fakes/xero-accounting'

const PASSWORD = 'export-recovery-password-123!'
const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const CONTACT_ID = '33333333-3333-4333-8333-333333333333'
const ITEM_ID = '44444444-4444-4444-8444-444444444444'

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

const createSucceededDraft = async (
  description: string,
  batchReference: string,
  invoiceSequence: number,
) => {
  const reserved = await reserveOneEntry(description, batchReference)
  const fake = new FakeXeroAccountingServer()
  fake.setInvoiceSequence(invoiceSequence)
  await expect(
    processInvoiceExport(ownerSession.req, reserved.exportID, {
      client: fake.client(),
      token: token(),
    }),
  ).resolves.toEqual({ state: 'succeeded' })
  const exportDocument = await payload.findByID({
    collection: 'invoice-exports',
    depth: 0,
    id: reserved.exportID,
    overrideAccess: true,
  })
  if (!exportDocument.xeroInvoiceId) throw new Error('The fake Xero draft was not created.')
  return {
    ...reserved,
    applicationReference: exportDocument.applicationReference,
    exportDocument,
    fake,
    invoiceID: exportDocument.xeroInvoiceId,
  }
}

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
        code: 'TIME',
        metadata: { isSold: true },
        name: 'Professional services',
        resourceType: 'item',
        status: 'active',
        xeroId: ITEM_ID,
      },
      {
        code: 'CreateDraftInvoice',
        name: 'CreateDraftInvoice',
        resourceType: 'organisation-action',
        status: 'active',
        xeroId: 'CreateDraftInvoice',
      },
      {
        code: 'DeleteDraftInvoice',
        name: 'DeleteDraftInvoice',
        resourceType: 'organisation-action',
        status: 'active',
        xeroId: 'DeleteDraftInvoice',
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
        invoiceReferenceCode: 'RECOVERY',
        invoiceReferenceStartNumber: 1,
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
        xeroItemId: ITEM_ID,
      },
      overrideAccess: true,
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

  it('keeps an authorised and sent invoice succeeded after refresh', async () => {
    const draft = await createSucceededDraft(
      'Refresh an authorised and sent invoice',
      'EFEFEFEF-EFEF-4FEF-8FEF-EFEFEFEFEFEF',
      390,
    )
    const invoice = draft.fake.invoice(draft.invoiceID)
    if (!invoice) throw new Error('The fake Xero draft was not found.')
    draft.fake.setInvoice({ ...invoice, SentToContact: true, Status: 'AUTHORISED' })

    await expect(
      refreshInvoiceExportStatus(ownerSession.req, draft.exportID, {
        client: draft.fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ remoteStatus: 'AUTHORISED', state: 'succeeded' })
    await expect(
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: draft.exportID,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({
      lastErrorCode: null,
      lastErrorMessage: null,
      remoteStatus: 'AUTHORISED',
      state: 'succeeded',
    })
  })

  it('detects a tax-only edit against the first verified Xero response', async () => {
    const draft = await createSucceededDraft(
      'Detect a changed Xero tax amount',
      'ADADADAD-ADAD-4DAD-8DAD-ADADADADADAD',
      395,
    )
    const invoice = draft.fake.invoice(draft.invoiceID)
    if (!invoice) throw new Error('The fake Xero draft was not found.')
    const verifiedInvoice = {
      ...invoice,
      LineItems: invoice.LineItems.map((line) => ({
        ...line,
        LineAmount: 150,
        TaxAmount: 22.5,
      })),
      SubTotal: 150,
      Total: 172.5,
    }
    draft.fake.setInvoice(verifiedInvoice)
    const remote = parseRemoteInvoices({ Invoices: [verifiedInvoice] })[0]
    const attemptID = relationshipID(draft.exportDocument.currentAttempt)
    const derivedValuesHash = remote ? remoteDerivedValuesHash(remote) : null
    if (!attemptID || !derivedValuesHash)
      throw new Error('The verified Xero response is incomplete.')

    await expect(
      refreshInvoiceExportStatus(ownerSession.req, draft.exportID, {
        client: draft.fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ remoteStatus: 'DRAFT', state: 'succeeded' })
    const backfilledAttempt = await payload.findByID({
      collection: 'xero-attempts',
      depth: 0,
      id: attemptID,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect(
      isRecord(backfilledAttempt.safeResponseMetadata)
        ? backfilledAttempt.safeResponseMetadata.remoteDerivedValuesHash
        : null,
    ).toBe(derivedValuesHash)

    draft.fake.setInvoice({
      ...verifiedInvoice,
      LineItems: verifiedInvoice.LineItems.map((line) => ({ ...line, TaxAmount: 22.49 })),
      Total: 172.49,
    })
    await expect(
      refreshInvoiceExportStatus(ownerSession.req, draft.exportID, {
        client: draft.fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ remoteStatus: 'DRAFT', state: 'action-required' })
    await payload.update({
      collection: 'invoice-exports',
      data: {
        processingLeaseExpiresAt: null,
        processingLeaseId: null,
        state: 'reconciling',
      },
      id: draft.exportID,
      overrideAccess: true,
    })
    await expect(
      reconcileInvoiceExport(ownerSession.req, draft.exportID, {
        client: draft.fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ state: 'manual-review' })
    await expect(
      payload.findByID({
        collection: 'xero-attempts',
        depth: 0,
        id: attemptID,
        overrideAccess: true,
        showHiddenFields: true,
      }),
    ).resolves.toMatchObject({
      result: 'succeeded',
      safeResponseMetadata: { remoteDerivedValuesHash: derivedValuesHash },
    })
  })

  it('deletes a verified Xero draft and atomically releases its time entry', async () => {
    const draft = await createSucceededDraft(
      'Delete and release a verified draft',
      '10101010-1010-4010-8010-101010101010',
      400,
    )

    const result = await deleteDraftInvoiceAndRelease(
      ownerSession,
      {
        exportID: draft.exportID,
      },
      { client: draft.fake.client(), token: token() },
    )

    const [entry, exportDocument, allocations, releases] = await Promise.all([
      payload.findByID({
        collection: 'time-entries',
        depth: 0,
        id: draft.entryID,
        overrideAccess: true,
      }),
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: draft.exportID,
        overrideAccess: true,
      }),
      payload.find({
        collection: 'invoice-export-entries',
        depth: 0,
        overrideAccess: true,
        where: { invoiceExport: { equals: draft.exportID } },
      }),
      payload.find({
        collection: 'release-actions',
        depth: 0,
        overrideAccess: true,
        where: { sourceExport: { equals: draft.exportID } },
      }),
    ])
    expect(result.entryIDs).toEqual([draft.entryID])
    expect(draft.fake.invoice(draft.invoiceID)?.Status).toBe('DELETED')
    expect(entry).toMatchObject({
      billingStatus: 'unbilled',
      currentExport: null,
      exportedAt: null,
      reservedAt: null,
    })
    expect(exportDocument).toMatchObject({ remoteStatus: 'DELETED', state: 'released' })
    expect(allocations.docs).toHaveLength(1)
    expect(allocations.docs[0]?.releasedAt).toBeTruthy()
    expect(releases.docs).toHaveLength(1)
    expect(releases.docs[0]).toMatchObject({
      before: {
        billingStatus: 'exported',
        billingStatusCounts: { exported: 1, reserved: 0 },
        currentExport: draft.exportID,
      },
      reason: 'Released mapped time after Xero confirmed the invoice was DELETED.',
      remoteStatus: 'DELETED',
      schemaVersion: 1,
    })
    expect(
      draft.fake.requests.filter(
        (request) => request.operation === 'post' && request.path === `Invoices/${draft.invoiceID}`,
      ),
    ).toHaveLength(1)
  })

  it('refuses to delete a non-draft invoice and leaves its time exported', async () => {
    const draft = await createSucceededDraft(
      'Do not delete an authorised invoice',
      '20202020-2020-4020-8020-202020202020',
      410,
    )
    const invoice = draft.fake.invoice(draft.invoiceID)
    if (!invoice) throw new Error('The fake Xero draft was not found.')
    draft.fake.setInvoice({ ...invoice, Status: 'AUTHORISED' })

    await expect(
      deleteDraftInvoiceAndRelease(
        ownerSession,
        {
          exportID: draft.exportID,
          reason: 'This authorised invoice must remain untouched in Xero.',
        },
        { client: draft.fake.client(), token: token() },
      ),
    ).rejects.toThrow(/DRAFT/)
    const entry = await payload.findByID({
      collection: 'time-entries',
      depth: 0,
      id: draft.entryID,
      overrideAccess: true,
    })
    expect(entry).toMatchObject({ billingStatus: 'exported', currentExport: draft.exportID })
    expect(draft.fake.invoice(draft.invoiceID)?.Status).toBe('AUTHORISED')
    expect(
      draft.fake.requests.filter(
        (request) => request.operation === 'post' && request.path === `Invoices/${draft.invoiceID}`,
      ),
    ).toHaveLength(0)
  })

  it('confirms a response-lost draft deletion by GET before releasing time', async () => {
    const draft = await createSucceededDraft(
      'Recover a response-lost draft deletion',
      '30303030-3030-4030-8030-303030303030',
      420,
    )
    draft.fake.enqueue('post', 'ambiguous-create')

    await expect(
      deleteDraftInvoiceAndRelease(
        ownerSession,
        {
          exportID: draft.exportID,
          reason: 'Confirm the lost Xero response before releasing this time.',
        },
        { client: draft.fake.client(), token: token() },
      ),
    ).resolves.toMatchObject({ entryIDs: [draft.entryID] })
    const entry = await payload.findByID({
      collection: 'time-entries',
      depth: 0,
      id: draft.entryID,
      overrideAccess: true,
    })
    expect(draft.fake.invoice(draft.invoiceID)?.Status).toBe('DELETED')
    expect(entry).toMatchObject({ billingStatus: 'unbilled', currentExport: null })
    expect(
      draft.fake.requests.filter(
        (request) => request.operation === 'get' && request.path === `Invoices/${draft.invoiceID}`,
      ).length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('keeps time exported when a failed deletion is still a Xero draft', async () => {
    const draft = await createSucceededDraft(
      'Keep exported time after failed deletion',
      '40404040-4040-4040-8040-404040404040',
      430,
    )
    draft.fake.enqueue('post', 'server-error')

    await expect(
      deleteDraftInvoiceAndRelease(
        ownerSession,
        {
          exportID: draft.exportID,
          reason: 'Do not release this time unless Xero confirms deletion.',
        },
        { client: draft.fake.client(), token: token() },
      ),
    ).rejects.toThrow()
    const [entry, releases] = await Promise.all([
      payload.findByID({
        collection: 'time-entries',
        depth: 0,
        id: draft.entryID,
        overrideAccess: true,
      }),
      payload.find({
        collection: 'release-actions',
        depth: 0,
        overrideAccess: true,
        where: { sourceExport: { equals: draft.exportID } },
      }),
    ])
    expect(draft.fake.invoice(draft.invoiceID)?.Status).toBe('DRAFT')
    expect(entry).toMatchObject({ billingStatus: 'exported', currentExport: draft.exportID })
    expect(releases.docs).toHaveLength(0)
  })

  it('safely completes a local release when the same draft is already deleted', async () => {
    const draft = await createSucceededDraft(
      'Resume release after confirmed remote deletion',
      '50505050-5050-4050-8050-505050505050',
      440,
    )
    const invoice = draft.fake.invoice(draft.invoiceID)
    if (!invoice) throw new Error('The fake Xero draft was not found.')
    draft.fake.setInvoice({ ...invoice, Status: 'DELETED' })

    await expect(
      deleteDraftInvoiceAndRelease(
        ownerSession,
        {
          exportID: draft.exportID,
          reason: 'Complete the local release after verified Xero deletion.',
        },
        { client: draft.fake.client(), token: token() },
      ),
    ).resolves.toMatchObject({ entryIDs: [draft.entryID] })
    const entry = await payload.findByID({
      collection: 'time-entries',
      depth: 0,
      id: draft.entryID,
      overrideAccess: true,
    })
    expect(entry).toMatchObject({ billingStatus: 'unbilled', currentExport: null })
    expect(
      draft.fake.requests.filter(
        (request) => request.operation === 'post' && request.path === `Invoices/${draft.invoiceID}`,
      ),
    ).toHaveLength(0)
  })

  it('allows only one concurrent delete-and-release command to commit', async () => {
    const draft = await createSucceededDraft(
      'Concurrent draft deletion and release',
      '60606060-6060-4060-8060-606060606060',
      450,
    )
    const secondSession: AppSession = {
      ...ownerSession,
      req: await createLocalReq({ user: ownerSession.user }, payload),
    }
    const input = {
      exportID: draft.exportID,
      reason: 'Only one concurrent draft release may commit locally.',
    }

    const results = await Promise.allSettled([
      deleteDraftInvoiceAndRelease(ownerSession, input, {
        client: draft.fake.client(),
        token: token(),
      }),
      deleteDraftInvoiceAndRelease(secondSession, input, {
        client: draft.fake.client(),
        token: token(),
      }),
    ])
    const releases = await payload.find({
      collection: 'release-actions',
      depth: 0,
      overrideAccess: true,
      where: { sourceExport: { equals: draft.exportID } },
    })
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(releases.docs).toHaveLength(1)
    expect(draft.fake.invoice(draft.invoiceID)?.Status).toBe('DELETED')
  })

  it('releases reserved time only after a mismatched remote invoice is deleted', async () => {
    const reserved = await reserveOneEntry(
      'Item code mismatch recovery',
      'ACACACAC-ACAC-4CAC-8CAC-ACACACACACAC',
    )
    const fake = new FakeXeroAccountingServer()
    fake.setInvoiceSequence(300)
    fake.enqueue('post', 'ambiguous-create')

    await expect(
      processInvoiceExport(ownerSession.req, reserved.exportID, {
        client: fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ state: 'reconciling' })

    const invoiceID = '00000000-0000-4000-8000-000000000301'
    const created = fake.invoice(invoiceID)
    if (!created) throw new Error('The fake Xero invoice was not created.')
    fake.setInvoice({
      ...created,
      LineItems: created.LineItems.map((line) => ({ ...line, ItemCode: 'DIFFERENT' })),
    })

    await expect(
      reconcileInvoiceExport(ownerSession.req, reserved.exportID, {
        client: fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ state: 'manual-review' })
    const [manualReviewExport, reservedEntry] = await Promise.all([
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: reserved.exportID,
        overrideAccess: true,
      }),
      payload.findByID({
        collection: 'time-entries',
        depth: 0,
        id: reserved.entryID,
        overrideAccess: true,
      }),
    ])
    expect(manualReviewExport).toMatchObject({
      lastErrorCode: 'reconciliation-mismatch',
      state: 'manual-review',
      xeroInvoiceId: invoiceID,
    })
    expect(reservedEntry).toMatchObject({
      billingStatus: 'reserved',
      currentExport: reserved.exportID,
    })

    await expect(
      deleteDraftInvoiceAndRelease(
        ownerSession,
        { exportID: reserved.exportID },
        { client: fake.client(), token: token() },
      ),
    ).rejects.toThrow(/still be exported/)
    expect(fake.invoice(invoiceID)?.Status).toBe('DRAFT')

    const mismatchedInvoice = fake.invoice(invoiceID)
    if (!mismatchedInvoice) throw new Error('The mismatched Xero invoice was not found.')
    fake.setInvoice({ ...mismatchedInvoice, Status: 'DELETED' })
    const fetchDeletedInvoice = (session: AppSession, document: InvoiceExport) =>
      fetchRemoteInvoiceForExport(session, document, fake.client(), token())
    const processingLeaseID = 'active-release-race-lease'
    await payload.update({
      collection: 'invoice-exports',
      data: {
        processingLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        processingLeaseId: processingLeaseID,
        state: 'reconciling',
      },
      depth: 0,
      id: reserved.exportID,
      overrideAccess: true,
    })
    await expect(
      refreshInvoiceExportStatus(ownerSession.req, reserved.exportID, {
        client: fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ remoteStatus: 'DELETED', state: 'action-required' })
    await expect(
      payload.findByID({
        collection: 'time-entries',
        depth: 0,
        id: reserved.entryID,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({
      billingStatus: 'reserved',
      currentExport: reserved.exportID,
    })
    await expect(
      payload.findByID({
        collection: 'invoice-exports',
        depth: 0,
        id: reserved.exportID,
        overrideAccess: true,
        showHiddenFields: true,
      }),
    ).resolves.toMatchObject({
      lastErrorCode: 'remote-invoice-mismatch',
      processingLeaseId: processingLeaseID,
      state: 'action-required',
    })
    await expect(
      releaseInvoiceExport(
        ownerSession,
        { exportID: reserved.exportID },
        { fetchRemote: fetchDeletedInvoice },
      ),
    ).rejects.toThrow(/still being processed/)
    await expect(
      payload.findByID({
        collection: 'time-entries',
        depth: 0,
        id: reserved.entryID,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({
      billingStatus: 'reserved',
      currentExport: reserved.exportID,
    })
    await payload.update({
      collection: 'invoice-exports',
      data: { processingLeaseExpiresAt: null, processingLeaseId: null },
      depth: 0,
      id: reserved.exportID,
      overrideAccess: true,
    })

    await expect(
      releaseInvoiceExport(
        ownerSession,
        { exportID: reserved.exportID },
        { fetchRemote: fetchDeletedInvoice },
      ),
    ).resolves.toMatchObject({ entryIDs: [reserved.entryID] })

    const [releasedEntry, releasedExport, releases] = await Promise.all([
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
        collection: 'release-actions',
        depth: 0,
        overrideAccess: true,
        where: { sourceExport: { equals: reserved.exportID } },
      }),
    ])
    expect(releasedEntry).toMatchObject({
      billingStatus: 'unbilled',
      currentExport: null,
      exportedAt: null,
      reservedAt: null,
    })
    expect(releasedExport).toMatchObject({
      lastErrorCode: null,
      lastErrorMessage: null,
      remoteStatus: 'DELETED',
      state: 'released',
    })
    expect(releases.docs).toHaveLength(1)
    expect(releases.docs[0]).toMatchObject({
      before: {
        billingStatus: 'reserved',
        billingStatusCounts: { exported: 0, reserved: 1 },
        currentExport: reserved.exportID,
      },
      reason: 'Released mapped time after Xero confirmed the invoice was DELETED.',
      remoteStatus: 'DELETED',
    })
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

  it('narrows same-reference reconciliation matches by contact and currency', async () => {
    const reserved = await reserveOneEntry(
      'Reference collision recovery',
      'ABABABAB-ABAB-4BAB-8BAB-ABABABABABAB',
    )
    const fake = new FakeXeroAccountingServer()
    fake.setInvoiceSequence(200)
    fake.enqueue('post', 'ambiguous-create')

    await expect(
      processInvoiceExport(ownerSession.req, reserved.exportID, {
        client: fake.client(),
        token: token(),
      }),
    ).resolves.toEqual({ state: 'reconciling' })
    const exportDocument = await payload.findByID({
      collection: 'invoice-exports',
      depth: 0,
      id: reserved.exportID,
      overrideAccess: true,
    })
    fake.setInvoice({
      Contact: { ContactID: '44444444-4444-4444-8444-444444444444' },
      CurrencyCode: 'NZD',
      InvoiceID: '55555555-5555-4555-8555-555555555555',
      LineItems: [],
      Reference: exportDocument.applicationReference,
      Status: 'DRAFT',
    })
    fake.setInvoice({
      Contact: { ContactID: CONTACT_ID },
      CurrencyCode: 'AUD',
      InvoiceID: '66666666-6666-4666-8666-666666666666',
      LineItems: [],
      Reference: exportDocument.applicationReference,
      Status: 'DRAFT',
    })

    const reconciliation = await reconcileInvoiceExport(ownerSession.req, reserved.exportID, {
      client: fake.client(),
      token: token(),
    })
    const reconciled = await payload.findByID({
      collection: 'invoice-exports',
      depth: 0,
      id: reserved.exportID,
      overrideAccess: true,
    })
    expect({
      lastErrorCode: reconciled.lastErrorCode,
      lastErrorMessage: reconciled.lastErrorMessage,
      result: reconciliation,
      state: reconciled.state,
    }).toEqual({
      lastErrorCode: null,
      lastErrorMessage: null,
      result: { state: 'succeeded' },
      state: 'succeeded',
    })
    expect(fake.invoiceCount()).toBe(3)
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
