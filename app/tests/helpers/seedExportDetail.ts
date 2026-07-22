import { createLocalReq, getPayload } from 'payload'

import { cleanupNavigationRoleFixture, seedNavigationRoleFixture, testUser } from './seedUser'
import { TIME_ENTRY_BILLING_MUTATION_CONTEXT } from '../../src/collections/TimeEntries.js'
import config from '../../src/payload.config.js'

export type ExportDetailFixtureRecord = {
  id: string
  lineDescription: string
  reference: string
}

export type ExportDetailFixture = {
  completed: ExportDetailFixtureRecord
  manualReview: ExportDetailFixtureRecord
  reconciling: ExportDetailFixtureRecord
  releaseable: ExportDetailFixtureRecord
  replacement: ExportDetailFixtureRecord
  succeeded: ExportDetailFixtureRecord
}

type ExportDetailScenario = {
  lastErrorCode?: string
  lastErrorMessage?: string
  reference: string
  remoteStatus?: 'AUTHORISED' | 'DELETED' | 'DRAFT'
  state: 'action-required' | 'manual-review' | 'reconciling' | 'succeeded'
  xeroInvoiceId?: string
  xeroInvoiceNumber?: string
}

type SeededTimeEntry = { id: string }

const fixtureScenarios = [
  {
    reference: 'E2E-DETAIL-SUCCEEDED',
    remoteStatus: 'DRAFT',
    state: 'succeeded',
    xeroInvoiceId: '11111111-aaaa-4111-8111-111111111111',
    xeroInvoiceNumber: 'E2E-DRAFT-001',
  },
  {
    reference: 'E2E-DETAIL-COMPLETED',
    remoteStatus: 'AUTHORISED',
    state: 'succeeded',
    xeroInvoiceId: '66666666-ffff-4666-8666-666666666666',
    xeroInvoiceNumber: 'E2E-APPROVED-001',
  },
  {
    lastErrorCode: 'material-response-mismatch',
    lastErrorMessage: 'Xero created an invoice whose material values require manual review.',
    reference: 'E2E-DETAIL-MANUAL-REVIEW',
    remoteStatus: 'DRAFT',
    state: 'manual-review',
    xeroInvoiceId: '22222222-bbbb-4222-8222-222222222222',
    xeroInvoiceNumber: 'E2E-DRAFT-002',
  },
  {
    reference: 'E2E-DETAIL-RECONCILING',
    state: 'reconciling',
  },
  {
    lastErrorCode: 'remote-invoice-requires-action',
    lastErrorMessage: 'The Xero invoice is DELETED; review release eligibility.',
    reference: 'E2E-DETAIL-DELETED',
    remoteStatus: 'DELETED',
    state: 'action-required',
    xeroInvoiceId: '55555555-eeee-4555-8555-555555555555',
    xeroInvoiceNumber: 'E2E-DELETED-001',
  },
  {
    lastErrorCode: 'confirmed-absent-replacement-approval-required',
    lastErrorMessage: 'Xero confirmed that the original invoice is absent.',
    reference: 'E2E-DETAIL-REPLACEMENT',
    state: 'manual-review',
  },
] as const satisfies readonly ExportDetailScenario[]

/**
 * Seeds immutable export snapshots for the export-detail state and role matrix.
 * No Xero processing is scheduled; the browser cases only read these documents.
 */
export async function seedExportDetailFixture(): Promise<ExportDetailFixture> {
  await seedNavigationRoleFixture()

  const payload = await getPayload({ config })
  const ownerResult = await payload.find({
    collection: 'users',
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: testUser.email } },
  })
  const owner = ownerResult.docs[0]
  if (!owner) throw new Error('The export-detail fixture owner was not created.')

  const ownerReq = await createLocalReq({ user: owner }, payload)
  const seededAt = new Date().toISOString()
  const tenantID = 'e2e-export-detail-tenant'
  const xeroContactID = '33333333-cccc-4333-8333-333333333333'
  const xeroItemID = '44444444-dddd-4444-8444-444444444444'

  await payload.create({
    collection: 'xero-connections',
    data: {
      grantedScopes: [
        'offline_access',
        'accounting.invoices',
        'accounting.contacts',
        'accounting.settings.read',
      ],
      singletonKey: 'business-accounting',
      status: 'connected',
      tenantId: tenantID,
      tenantName: 'Export Detail E2E Company',
      tokenVersion: 0,
    },
    overrideAccess: true,
    req: ownerReq,
  })

  await payload.create({
    collection: 'xero-reference-data',
    data: {
      code: 'TIME',
      fetchedAt: seededAt,
      metadata: { isSold: true },
      name: 'Professional services',
      resourceType: 'item',
      sourceTenantId: tenantID,
      status: 'active',
      xeroId: xeroItemID,
    },
    overrideAccess: true,
    req: ownerReq,
  })

  const customer = await payload.create({
    collection: 'customers',
    data: {
      currency: 'NZD',
      name: 'Export Detail E2E Customer',
      status: 'active',
      xeroContactId: xeroContactID,
      xeroContactNameSnapshot: 'Export Detail E2E Customer Limited',
      xeroLastValidatedAt: seededAt,
      xeroMappingStatus: 'active',
    },
    overrideAccess: true,
    req: ownerReq,
  })

  const project = await payload.create({
    collection: 'projects',
    data: {
      billableByDefault: true,
      code: 'E2E-DETAIL',
      currency: 'NZD',
      customer: customer.id,
      hourlyRateScaled: 1_000_000,
      name: 'Export Detail Browser Project',
      status: 'active',
      xeroItemId: xeroItemID,
    },
    overrideAccess: true,
    req: ownerReq,
  })

  const timeEntries: SeededTimeEntry[] = []
  for (const scenario of fixtureScenarios) {
    timeEntries.push(
      await payload.create({
        collection: 'time-entries',
        data: {
          description: `${scenario.reference} source time`,
          enteredHours: 1,
          enteredMinutes: 0,
          inputMode: 'duration',
          project: project.id,
          timezone: testUser.timezone,
          workDate: '2026-07-22',
        } as never,
        overrideAccess: false,
        req: ownerReq,
      }),
    )
  }

  const subtotalScaled = 1_000_000
  const taxScaled = 150_000
  const totalScaled = subtotalScaled + taxScaled
  const batch = await payload.create({
    collection: 'export-batches',
    data: {
      actualMode: 'background',
      applicationReference: 'BATCH-E2E-EXPORT-DETAIL',
      durationSeconds: 3_600 * fixtureScenarios.length,
      entryCount: fixtureScenarios.length,
      explicitEntryIds: timeEntries.map((entry) => String(entry.id)),
      invoiceCount: fixtureScenarios.length,
      normalizedFilterSnapshot: { fixture: 'export-detail' },
      requestedBy: owner.id,
      requestedMode: 'background',
      schemaVersion: 1,
      selectionType: 'explicit',
      snapshotHash: 'e2e-export-detail-selection',
      status: 'partial',
      totalAmountScaled: totalScaled * fixtureScenarios.length,
    },
    overrideAccess: true,
    req: ownerReq,
  })

  const createExport = async (
    scenario: ExportDetailScenario,
    timeEntry: (typeof timeEntries)[number],
  ): Promise<ExportDetailFixtureRecord> => {
    const lineDescription = `${scenario.reference} mapped invoice line`
    const invoiceExport = await payload.create({
      collection: 'invoice-exports',
      data: {
        actualMode: 'background',
        applicationReference: scenario.reference,
        batch: batch.id,
        currency: 'NZD',
        currentAttemptNumber: 1,
        customer: customer.id,
        dispatchState: scenario.state === 'reconciling' ? 'dispatched' : 'complete',
        dueDate: '2026-08-20T00:00:00.000Z',
        durationSeconds: 3_600,
        entryCount: 1,
        invoiceDate: '2026-07-22T00:00:00.000Z',
        lastErrorCode: scenario.lastErrorCode,
        lastErrorMessage: scenario.lastErrorMessage,
        lastReconciledAt: scenario.remoteStatus ? seededAt : undefined,
        payloadHash: `e2e-${scenario.state}-payload`,
        remoteStatus: scenario.remoteStatus,
        requestPayload: {
          Contact: { ContactID: xeroContactID },
          Date: '2026-07-22',
          DueDate: '2026-08-20',
          LineAmountTypes: 'Exclusive',
          LineItems: [
            {
              AccountCode: '200',
              Description: lineDescription,
              ItemCode: 'TIME',
              Quantity: 1,
              TaxType: 'OUTPUT2',
              UnitAmount: 100,
            },
          ],
          Reference: scenario.reference,
          Type: 'ACCREC',
        },
        requestedBy: owner.id,
        requestedMode: 'background',
        schemaVersion: 1,
        selectionHash: 'e2e-export-detail-selection',
        state: scenario.state,
        stateHistory: [{ actor: String(owner.id), at: seededAt, from: null, to: scenario.state }],
        subtotalScaled,
        succeededAt: scenario.state === 'succeeded' ? seededAt : undefined,
        taxScaled,
        totalScaled,
        xeroInvoiceId: scenario.xeroInvoiceId,
        xeroInvoiceNumber: scenario.xeroInvoiceNumber,
      },
      overrideAccess: true,
      req: ownerReq,
    })

    await payload.create({
      collection: 'invoice-export-entries',
      data: {
        accountCode: '200',
        amountScaled: subtotalScaled,
        currency: 'NZD',
        customer: customer.id,
        description: lineDescription,
        durationSeconds: 3_600,
        invoiceExport: invoiceExport.id,
        itemCode: 'TIME',
        itemName: 'Professional services',
        lineOrdinal: 0,
        project: project.id,
        projectCode: 'E2E-DETAIL',
        projectName: 'Export Detail Browser Project',
        quantityScaled: 10_000,
        rateScaled: subtotalScaled,
        schemaVersion: 1,
        taxScaled,
        taxType: 'OUTPUT2',
        timeEntry: timeEntry.id,
        timezone: testUser.timezone,
        tracking: [],
        user: owner.id,
        userName: testUser.displayName,
        workDate: '2026-07-22',
        xeroItemId: xeroItemID,
      },
      overrideAccess: true,
      req: ownerReq,
    })

    await payload.update({
      collection: 'time-entries',
      context: { [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'reserve' },
      data: {
        billingStatus: 'reserved',
        currentExport: invoiceExport.id,
        exportedAt: null,
        reservedAt: seededAt,
      },
      id: timeEntry.id,
      overrideAccess: true,
      req: ownerReq,
    })

    if (scenario.state === 'succeeded') {
      await payload.update({
        collection: 'time-entries',
        context: { [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'export' },
        data: {
          billingStatus: 'exported',
          currentExport: invoiceExport.id,
          exportedAt: seededAt,
          reservedAt: seededAt,
        },
        id: timeEntry.id,
        overrideAccess: true,
        req: ownerReq,
      })
    }

    return {
      id: String(invoiceExport.id),
      lineDescription,
      reference: scenario.reference,
    }
  }

  const succeeded = await createExport(fixtureScenarios[0], timeEntries[0]!)
  const completed = await createExport(fixtureScenarios[1], timeEntries[1]!)
  const manualReview = await createExport(fixtureScenarios[2], timeEntries[2]!)
  const reconciling = await createExport(fixtureScenarios[3], timeEntries[3]!)
  const releaseable = await createExport(fixtureScenarios[4], timeEntries[4]!)
  const replacement = await createExport(fixtureScenarios[5], timeEntries[5]!)

  return { completed, manualReview, reconciling, releaseable, replacement, succeeded }
}

/** Removes the isolated export-detail fixture and any browser-test side effects. */
export async function cleanupExportDetailFixture(): Promise<void> {
  await cleanupNavigationRoleFixture()
}
