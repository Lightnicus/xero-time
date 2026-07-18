let sequence = 0

const next = (prefix: string): string => {
  sequence += 1
  return `${prefix}-${String(sequence).padStart(4, '0')}`
}

const merge = <T extends Record<string, unknown>>(defaults: T, overrides: Partial<T> = {}): T => ({
  ...defaults,
  ...overrides,
})

export const resetFactorySequence = (): void => {
  sequence = 0
}

export const userFactory = (overrides = {}) =>
  merge(
    {
      _verified: true,
      active: true,
      displayName: 'Test Member',
      email: `${next('user')}@example.test`,
      password: 'factory-password-123!',
      role: 'member',
      timezone: 'Pacific/Auckland',
    },
    overrides,
  )

export const invitationFactory = (overrides = {}) =>
  merge(
    {
      cleanupAt: '2026-08-01T00:00:00.000Z',
      displayName: 'Invited User',
      email: `${next('invite')}@example.test`,
      expiresAt: '2026-07-25T00:00:00.000Z',
      issuedAt: '2026-07-18T00:00:00.000Z',
      role: 'member',
      status: 'pending',
      timezone: 'Pacific/Auckland',
      tokenHash: next('invitation-hash'),
    },
    overrides,
  )

export const authIdentityFactory = (overrides = {}) =>
  merge(
    {
      issuer: 'https://identity.xero.com',
      linkedAt: '2026-07-18T00:00:00.000Z',
      provider: 'xero',
      status: 'active',
      subject: next('xero-subject'),
      user: next('user-id'),
    },
    overrides,
  )

export const externalAuthSessionFactory = (overrides = {}) =>
  merge(
    {
      absoluteExpiresAt: '2026-08-17T00:00:00.000Z',
      cleanupAt: '2026-09-16T00:00:00.000Z',
      identity: next('identity-id'),
      idleExpiresAt: '2026-07-25T00:00:00.000Z',
      issuedAt: '2026-07-18T00:00:00.000Z',
      lastSeenAt: '2026-07-18T00:00:00.000Z',
      status: 'active',
      tokenHash: next('session-hash'),
      user: next('user-id'),
      version: 1,
    },
    overrides,
  )

export const customerFactory = (overrides = {}) =>
  merge(
    { currency: 'NZD', name: next('Customer'), status: 'active', xeroMappingStatus: 'unmapped' },
    overrides,
  )

export const projectFactory = (overrides = {}) =>
  merge(
    {
      billableByDefault: true,
      code: next('PROJECT').toUpperCase(),
      currency: 'NZD',
      customer: next('customer-id'),
      hourlyRateScaled: 1_500_000,
      name: 'Factory Project',
      status: 'active',
    },
    overrides,
  )

export const timeEntryFactory = (overrides = {}) =>
  merge(
    {
      billable: true,
      description: 'Factory time entry',
      enteredHours: 1,
      enteredMinutes: 0,
      inputMode: 'duration',
      owner: next('user-id'),
      project: next('project-id'),
      timezone: 'Pacific/Auckland',
      workDate: '2026-07-18',
    },
    overrides,
  )

export const xeroConnectionFactory = (overrides = {}) =>
  merge(
    {
      connectionId: next('connection-id'),
      grantedScopes: [
        'offline_access',
        'accounting.invoices',
        'accounting.contacts',
        'accounting.settings.read',
      ],
      singletonKey: 'business-accounting',
      status: 'connected',
      tenantId: next('tenant-id'),
      tokenVersion: 1,
    },
    overrides,
  )

export const xeroOAuthStateFactory = (overrides = {}) =>
  merge(
    {
      browserBindingHash: next('binding-hash'),
      expiresAt: '2026-07-18T00:10:00.000Z',
      family: 'identity',
      purpose: 'sign-in',
      stateHash: next('state-hash'),
      status: 'pending',
    },
    overrides,
  )

export const xeroReferenceFactory = (overrides = {}) =>
  merge(
    {
      code: '200',
      fetchedAt: '2026-07-18T00:00:00.000Z',
      name: 'Sales',
      resourceType: 'account',
      sourceTenantId: next('tenant-id'),
      status: 'active',
      xeroId: next('account-id'),
    },
    overrides,
  )

export const exportBatchFactory = (overrides = {}) =>
  merge(
    {
      actualMode: 'background',
      applicationReference: next('BATCH').toUpperCase(),
      durationSeconds: 3_600,
      entryCount: 1,
      invoiceCount: 1,
      requestedBy: next('user-id'),
      requestedMode: 'background',
      schemaVersion: 1,
      selectionType: 'explicit',
      snapshotHash: next('snapshot-hash'),
      status: 'preparing',
      totalAmountScaled: 1_500_000,
    },
    overrides,
  )

export const invoiceExportFactory = (overrides = {}) =>
  merge(
    {
      actualMode: 'background',
      applicationReference: next('TIME').toUpperCase(),
      batch: next('batch-id'),
      currency: 'NZD',
      currentAttemptNumber: 1,
      customer: next('customer-id'),
      dispatchState: 'pending',
      durationSeconds: 3_600,
      dueDate: '2026-08-17T00:00:00.000Z',
      entryCount: 1,
      invoiceDate: '2026-07-18T00:00:00.000Z',
      payloadHash: next('payload-hash'),
      requestPayload: {
        Contact: { ContactID: '00000000-0000-4000-8000-000000000001' },
        CurrencyCode: 'NZD',
        LineItems: [],
        Reference: 'FACTORY',
        Status: 'DRAFT',
        Type: 'ACCREC',
      },
      requestedBy: next('user-id'),
      requestedMode: 'background',
      schemaVersion: 1,
      selectionHash: next('selection-hash'),
      state: 'preparing',
      stateHistory: [],
      subtotalScaled: 1_500_000,
      taxScaled: 225_000,
      totalScaled: 1_725_000,
    },
    overrides,
  )

export const invoiceExportEntryFactory = (overrides = {}) =>
  merge(
    {
      amountScaled: 1_500_000,
      currency: 'NZD',
      description: 'Factory invoice line',
      durationSeconds: 3_600,
      invoiceExport: next('export-id'),
      lineOrdinal: 0,
      quantityScaled: 10_000,
      rateScaled: 1_500_000,
      schemaVersion: 1,
      taxScaled: 225_000,
      timeEntry: next('entry-id'),
      timezone: 'Pacific/Auckland',
      workDate: '2026-07-18',
    },
    overrides,
  )

export const xeroAttemptFactory = (overrides = {}) =>
  merge(
    {
      attemptNumber: 1,
      idempotencyKey: next('xt-idempotency'),
      invoiceExport: next('export-id'),
      method: 'POST',
      operation: 'create-invoice',
      payloadHash: next('payload-hash'),
      requestMayHaveBeenSent: false,
      result: 'pending',
    },
    overrides,
  )

export const webhookReceiptFactory = (overrides = {}) =>
  merge(
    {
      deduplicationKey: next('webhook-dedup'),
      eventAt: '2026-07-18T00:00:00.000Z',
      eventType: 'UPDATE',
      receivedAt: '2026-07-18T00:00:01.000Z',
      resourceId: next('invoice-id'),
      resourceType: 'INVOICE',
      retryCount: 0,
      status: 'pending',
      tenantId: next('tenant-id'),
    },
    overrides,
  )

export const contactOperationFactory = (overrides = {}) =>
  merge(
    {
      applicationReference: next('CONTACT').toUpperCase(),
      customer: next('customer-id'),
      operation: 'create',
      requestMayHaveBeenSent: false,
      status: 'pending',
    },
    overrides,
  )

export const releaseActionFactory = (overrides = {}) =>
  merge(
    {
      actor: next('user-id'),
      amountScaled: 1_725_000,
      durationSeconds: 3_600,
      entryCount: 1,
      reason: 'Factory release reason.',
      releasedAt: '2026-07-18T00:00:00.000Z',
      remoteStatus: 'VOIDED',
      remoteVerifiedAt: '2026-07-18T00:00:00.000Z',
      schemaVersion: 1,
      sourceExport: next('export-id'),
    },
    overrides,
  )

export const auditEventFactory = (overrides = {}) =>
  merge(
    {
      actorType: 'machine',
      eventType: 'export.state-changed',
      machineActor: 'factory',
      occurredAt: '2026-07-18T00:00:00.000Z',
      schemaVersion: 1,
    },
    overrides,
  )

export const payloadJobFactory = (overrides = {}) =>
  merge(
    {
      input: { exportID: next('export-id') },
      processing: false,
      queue: 'xero',
      taskSlug: 'create-xero-invoice',
      totalTried: 0,
    },
    overrides,
  )
