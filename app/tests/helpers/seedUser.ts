import { createLocalReq, getPayload } from 'payload'

import config from '../../src/payload.config.js'

export const testUser = {
  _verified: true,
  active: true,
  displayName: 'Payload E2E Owner',
  email: 'dev@payloadcms.com',
  password: 'test-password-only',
  role: 'owner' as const,
  timezone: 'Pacific/Auckland' as const,
}

export const memberAppUser = {
  _verified: true,
  active: true,
  displayName: 'E2E Time Member',
  email: 'time-member@example.test',
  password: 'member-password-only',
  role: 'member' as const,
  timezone: 'Pacific/Auckland' as const,
}

export const adminAppUser = {
  _verified: true,
  active: true,
  displayName: 'E2E Navigation Admin',
  email: 'navigation-admin@example.test',
  password: 'admin-password-only',
  role: 'admin' as const,
  timezone: 'Pacific/Auckland' as const,
}

export const billerAppUser = {
  _verified: true,
  active: true,
  displayName: 'E2E Navigation Biller',
  email: 'navigation-biller@example.test',
  password: 'biller-password-only',
  role: 'biller' as const,
  timezone: 'Pacific/Auckland' as const,
}

export const adminRateProject = {
  code: 'E2E-RATE',
  name: 'Admin Rate Project',
}

const assertIsolatedE2EDatabase = (): void => {
  let mongoURI: URL

  try {
    mongoURI = new URL(process.env.MONGODB_URI ?? '')
  } catch {
    throw new Error('E2E tests refuse to modify any database except local xero_time_e2e.')
  }

  if (
    mongoURI.protocol !== 'mongodb:' ||
    mongoURI.hostname !== 'localhost' ||
    mongoURI.port !== '27018' ||
    mongoURI.pathname !== '/xero_time_e2e'
  ) {
    throw new Error('E2E tests refuse to modify any database except local xero_time_e2e.')
  }
}

const cleanE2EDatabase = async (payload: Awaited<ReturnType<typeof getPayload>>): Promise<void> => {
  const collections = [
    'payload-jobs',
    'release-actions',
    'invoice-export-entries',
    'xero-attempts',
    'invoice-exports',
    'export-batches',
    'xero-webhook-receipts',
    'xero-contact-operations',
    'xero-reference-data',
    'xero-oauth-states',
    'xero-connections',
    'external-auth-sessions',
    'auth-identities',
    'audit-events',
    'time-entries',
    'projects',
    'customers',
    'invitations',
    'users',
  ]

  for (const collection of collections) {
    await payload.db.collections[collection]?.deleteMany({})
    await payload.db.versions[collection]?.deleteMany({})
  }

  await payload.db.connection.db?.collection('application_bootstrap_locks').deleteMany({})
  await payload.db.connection.db?.collection('application_rate_limits').deleteMany({})
}

/**
 * Seeds a complete, locally billable fixture. Processing remains paused so the
 * browser suite proves reservation/cancellation without contacting Xero.
 */
export async function seedBillingAppFixture(): Promise<void> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })

  await cleanE2EDatabase(payload)

  const owner = await payload.create({
    collection: 'users',
    data: testUser,
    disableVerificationEmail: true,
    overrideAccess: true,
  })
  const ownerReq = await createLocalReq({ user: owner }, payload)

  const tenantID = 'e2e-demo-tenant'
  const itemID = '22222222-2222-4222-8222-222222222222'
  const fetchedAt = new Date().toISOString()
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
      tenantName: 'E2E Demo Company',
      tokenVersion: 0,
    },
    overrideAccess: true,
    req: ownerReq,
  })

  const references = [
    {
      code: 'CreateDraftInvoice',
      name: 'Create draft invoices',
      resourceType: 'organisation-action' as const,
    },
    {
      code: '200',
      name: 'Sales',
      resourceType: 'account' as const,
      type: 'REVENUE',
    },
    {
      code: 'OUTPUT2',
      metadata: { canApplyToRevenue: true, effectiveRate: 15 },
      name: 'GST on Income',
      resourceType: 'tax-rate' as const,
    },
    {
      code: 'NZD',
      name: 'New Zealand Dollar',
      resourceType: 'currency' as const,
    },
    {
      code: 'TIME',
      metadata: { isSold: true },
      name: 'Professional services',
      resourceType: 'item' as const,
      xeroId: itemID,
    },
  ]

  for (const reference of references) {
    await payload.create({
      collection: 'xero-reference-data',
      data: {
        ...reference,
        fetchedAt,
        sourceTenantId: tenantID,
        status: 'active',
      },
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
      invoiceReferencePrefix: 'E2E-',
      lineAmountType: 'Exclusive',
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
      invoiceReferenceCode: 'E2E-CUSTOMER',
      invoiceReferenceStartNumber: 1,
      name: 'Billable E2E Customer',
      status: 'active',
      xeroContactId: '11111111-1111-4111-8111-111111111111',
      xeroContactNameSnapshot: 'Billable E2E Customer Limited',
      xeroLastValidatedAt: fetchedAt,
      xeroMappingStatus: 'active',
    },
    overrideAccess: true,
    req: ownerReq,
  })

  const project = await payload.create({
    collection: 'projects',
    data: {
      billableByDefault: true,
      code: 'E2E-BILL',
      currency: 'NZD',
      customer: customer.id,
      hourlyRateScaled: 1_800_000,
      name: 'Browser Billing Project',
      status: 'active',
      xeroItemId: itemID,
    },
    overrideAccess: true,
    req: ownerReq,
  })

  for (const [description, hours, minutes] of [
    ['Billing discovery workshop', 1, 15],
    ['Billing implementation review', 0, 45],
  ] as const) {
    await payload.create({
      collection: 'time-entries',
      data: {
        description,
        enteredHours: hours,
        enteredMinutes: minutes,
        inputMode: 'duration',
        project: project.id,
        timezone: testUser.timezone,
        workDate: '2026-07-18',
      } as never,
      overrideAccess: false,
      req: ownerReq,
    })
  }

  await payload.update({
    collection: 'projects',
    id: project.id,
    data: {
      commercialChangeReason: 'Prepare a deterministic browser recalculation preview.',
      confirmUnbilledImpact: true,
      hourlyRateScaled: 2_000_000,
    },
    overrideAccess: false,
    req: ownerReq,
  })
}

/**
 * Seeds a test user for e2e admin tests.
 */
export async function seedTestUser(): Promise<void> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })

  // The entire database is test-only, so a prior interrupted run is safe to clean directly.
  await cleanE2EDatabase(payload)

  const owner = await payload.create({
    collection: 'users',
    data: testUser,
    disableVerificationEmail: true,
    overrideAccess: true,
  })
  const ownerReq = await createLocalReq({ user: owner }, payload)
  const customer = await payload.create({
    collection: 'customers',
    data: {
      currency: 'NZD',
      name: 'Admin Rate Customer',
      status: 'active',
      xeroMappingStatus: 'unmapped',
    },
    overrideAccess: false,
    req: ownerReq,
  })

  await payload.create({
    collection: 'projects',
    data: {
      billableByDefault: true,
      code: adminRateProject.code,
      currency: 'NZD',
      customer: customer.id,
      hourlyRateScaled: 1_500_000,
      name: adminRateProject.name,
      status: 'active',
    },
    overrideAccess: false,
    req: ownerReq,
  })
}

/** Seeds an active project and a member who can use the custom time application. */
export async function seedMemberAppFixture(): Promise<void> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })

  await cleanE2EDatabase(payload)

  const owner = await payload.create({
    collection: 'users',
    data: testUser,
    disableVerificationEmail: true,
    overrideAccess: true,
  })
  const ownerReq = await createLocalReq({ user: owner }, payload)

  await payload.create({
    collection: 'users',
    data: memberAppUser,
    disableVerificationEmail: true,
    overrideAccess: false,
    req: ownerReq,
  })

  const customer = await payload.create({
    collection: 'customers',
    data: {
      currency: 'NZD',
      name: 'E2E Customer',
      status: 'active',
      xeroMappingStatus: 'unmapped',
    },
    overrideAccess: false,
    req: ownerReq,
  })

  await payload.create({
    collection: 'projects',
    data: {
      billableByDefault: true,
      code: 'E2E-WEB',
      currency: 'NZD',
      customer: customer.id,
      hourlyRateScaled: 1_500_000,
      name: 'Member Application Project',
      status: 'active',
    },
    overrideAccess: false,
    req: ownerReq,
  })

  const archivedCustomer = await payload.create({
    collection: 'customers',
    data: {
      currency: 'NZD',
      name: 'Archived E2E Customer',
      status: 'active',
      xeroMappingStatus: 'unmapped',
    },
    overrideAccess: false,
    req: ownerReq,
  })

  await payload.create({
    collection: 'projects',
    data: {
      billableByDefault: true,
      code: 'E2E-ARCHIVED',
      currency: 'NZD',
      customer: archivedCustomer.id,
      hourlyRateScaled: 1_500_000,
      name: 'Unavailable Archived Customer Project',
      status: 'active',
    },
    overrideAccess: false,
    req: ownerReq,
  })

  await payload.update({
    collection: 'customers',
    id: archivedCustomer.id,
    data: { status: 'archived' },
    overrideAccess: false,
    req: ownerReq,
  })
}

/** Seeds one deterministic user for every custom-application navigation role. */
export async function seedNavigationRoleFixture(): Promise<void> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })

  await cleanE2EDatabase(payload)

  const owner = await payload.create({
    collection: 'users',
    data: testUser,
    disableVerificationEmail: true,
    overrideAccess: true,
  })
  const ownerReq = await createLocalReq({ user: owner }, payload)

  for (const user of [adminAppUser, billerAppUser, memberAppUser]) {
    await payload.create({
      collection: 'users',
      data: user,
      disableVerificationEmail: true,
      overrideAccess: false,
      req: ownerReq,
    })
  }
}

/** Removes the isolated role-navigation fixture and any browser-test side effects. */
export async function cleanupNavigationRoleFixture(): Promise<void> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })

  await cleanE2EDatabase(payload)
}

export async function seedMemberTimeEntries(count: number): Promise<void> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })
  const [memberResult, projectResult] = await Promise.all([
    payload.find({
      collection: 'users',
      limit: 1,
      overrideAccess: true,
      where: { email: { equals: memberAppUser.email } },
    }),
    payload.find({
      collection: 'projects',
      limit: 1,
      overrideAccess: true,
      where: { code: { equals: 'E2E-WEB' } },
    }),
  ])
  const member = memberResult.docs[0]
  const project = projectResult.docs[0]

  if (!member || !project) throw new Error('The member application fixture is incomplete.')

  const memberReq = await createLocalReq({ user: member }, payload)

  for (let index = 0; index < count; index += 1) {
    await payload.create({
      collection: 'time-entries',
      data: {
        description: `Pagination entry ${String(index + 1).padStart(2, '0')}`,
        enteredHours: 0,
        enteredMinutes: 1,
        inputMode: 'duration',
        project: project.id,
        timezone: memberAppUser.timezone,
        workDate: '2026-07-17',
      } as never,
      overrideAccess: false,
      req: memberReq,
    })
  }
}

/** Keeps independently-scoped browser cases from sharing command/auth rate-limit budgets. */
export async function resetE2ERateLimits(): Promise<void> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })
  await payload.db.connection.db?.collection('application_rate_limits').deleteMany({})
}

/** Issues a real Payload reset token without relying on an external email provider. */
export async function issueE2EPasswordResetToken(email: string): Promise<string> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })
  const token = await payload.forgotPassword({
    collection: 'users',
    data: { email },
    disableEmail: true,
    overrideAccess: true,
  })

  if (!token) throw new Error(`Payload did not issue a reset token for ${email}.`)
  return token
}

/**
 * Cleans up test user after tests
 */
export async function cleanupTestUser(): Promise<void> {
  assertIsolatedE2EDatabase()
  const payload = await getPayload({ config })

  await cleanE2EDatabase(payload)
}
