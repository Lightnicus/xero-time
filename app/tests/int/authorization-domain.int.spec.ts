// @vitest-environment node

import {
  canAccessAdmin,
  createLocalReq,
  getPayload,
  registerFirstUserOperation,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { TIME_ENTRY_BILLING_MUTATION_CONTEXT } from '@/collections/TimeEntries'
import { transitionOwner } from '@/lib/account-lifecycle/owner-transition'
import {
  acceptInvitation,
  changeOwnPassword,
  completePasswordReset,
  issueInvitation,
  revokeInvitation,
} from '@/lib/account-lifecycle/service'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import {
  confirmProjectRateRecalculation,
  previewProjectRateRecalculation,
} from '@/lib/projects/rate-recalculation'
import { deleteUnbilledTimeEntryAsAdministrator } from '@/lib/time-entry/administration'
import type { XeroAccountingClient } from '@/lib/xero/accounting/client'
import { REQUIRED_ACCOUNTING_SCOPES } from '@/lib/xero/accounting/contracts'
import {
  checkAccountingConnectionHealth,
  completeAccountingCallback,
  configureAccountingOAuth,
  createAccountingAuthorization,
  disconnectAccountingConnection,
  getAccountingConnectionView,
  getAccountingTenantSelection,
  getValidAccountingAccessToken,
  resolveAccountingRuntime,
  selectAccountingTenant,
} from '@/lib/xero/accounting/service'
import type { AuthenticationSetting, BillingSetting } from '@/payload-types'
import config from '@/payload.config'

type DocumentID = number | string
type UserRole = 'admin' | 'biller' | 'member' | 'owner'

type TestUser = {
  active: boolean
  collection?: 'users'
  displayName: string
  email: string
  id: DocumentID
  role: UserRole
  timezone: string
}

type TestCustomer = {
  billingEmail?: string
  currency: string
  id: DocumentID
  name: string
  notes?: string
  status: string
}

type TestProject = {
  code: string
  currency: string
  customer: unknown
  hourlyRateScaled?: number
  id: DocumentID
  name: string
}

type TestTimeEntry = {
  billingStatus: string
  currencySnapshot: string
  customer: unknown
  customerNameSnapshot: string
  durationSeconds: number
  endAt?: null | string
  id: DocumentID
  owner: unknown
  projectCodeSnapshot: string
  projectNameSnapshot: string
  rateSnapshotScaled?: number
  startAt?: null | string
  timezone?: string
  workDate?: string
}

type WriteOptions = {
  overrideAccess?: boolean
  req?: PayloadRequest
}

const OWNER_EMAIL = 'owner.integration@example.test'
const PASSWORD = 'integration-password-123!'
const accountingCredentials = {
  clientID: 'integration-accounting-client',
  clientSecret: 'integration-accounting-secret',
} as const

let payload: Payload
let owner: TestUser
let admin: TestUser
let biller: TestUser
let member: TestUser
let secondMember: TestUser
let ownerReq: PayloadRequest
let adminReq: PayloadRequest
let billerReq: PayloadRequest
let memberReq: PayloadRequest
let secondMemberReq: PayloadRequest
let trustedBillingReq: PayloadRequest
let trustedReleaseReq: PayloadRequest
let customer: TestCustomer
let otherCustomer: TestCustomer
let project: TestProject
let memberEntry: TestTimeEntry
let secondMemberEntry: TestTimeEntry
let postRateEntry: TestTimeEntry

const relationshipID = (value: unknown): DocumentID | null => {
  if (typeof value === 'number' || typeof value === 'string') return value
  if (!value || typeof value !== 'object' || !('id' in value)) return null

  const id = value.id
  return typeof id === 'number' || typeof id === 'string' ? id : null
}

const createDocument = async <T>(
  collection: string,
  data: Record<string, unknown>,
  options: WriteOptions = {},
): Promise<T> =>
  (await payload.create({
    collection: collection as never,
    data: data as never,
    overrideAccess: options.overrideAccess,
    req: options.req,
  })) as unknown as T

const updateDocument = async <T>(
  collection: string,
  id: DocumentID,
  data: Record<string, unknown>,
  options: WriteOptions = {},
): Promise<T> =>
  (await payload.update({
    collection: collection as never,
    data: data as never,
    id,
    overrideAccess: options.overrideAccess,
    req: options.req,
  })) as unknown as T

const deleteDocument = async (
  collection: string,
  id: DocumentID,
  options: WriteOptions = {},
): Promise<unknown> =>
  payload.delete({
    collection: collection as never,
    id,
    overrideAccess: options.overrideAccess,
    req: options.req,
  })

const findDocument = async <T>(
  collection: string,
  id: DocumentID,
  options: WriteOptions = {},
): Promise<T> =>
  (await payload.findByID({
    collection: collection as never,
    depth: 0,
    id,
    overrideAccess: options.overrideAccess,
    req: options.req,
  })) as unknown as T

const findDocuments = async <T>(collection: string, options: WriteOptions = {}): Promise<T[]> => {
  const result = await payload.find({
    collection: collection as never,
    depth: 0,
    limit: 100,
    overrideAccess: options.overrideAccess,
    pagination: false,
    req: options.req,
  })

  return result.docs as unknown as T[]
}

const findGlobal = async <T>(slug: string, req: PayloadRequest): Promise<T> =>
  (await payload.findGlobal({
    slug: slug as never,
    overrideAccess: false,
    req,
  })) as unknown as T

const updateGlobal = async <T>(
  slug: string,
  data: Record<string, unknown>,
  req: PayloadRequest,
): Promise<T> =>
  (await payload.updateGlobal({
    slug: slug as never,
    data: data as never,
    overrideAccess: false,
    req,
  })) as unknown as T

const requestFor = (user: TestUser): Promise<PayloadRequest> =>
  createLocalReq(
    {
      user: {
        ...user,
        collection: 'users',
      } as never,
    },
    payload,
  )

const clearCollections = async (): Promise<void> => {
  for (const collection of [
    'xero-oauth-states',
    'xero-connections',
    'time-entries',
    'projects',
    'customers',
    'invitations',
    'users',
  ]) {
    await payload.db.collections[collection]?.deleteMany({})
    await payload.db.versions[collection]?.deleteMany({})
  }

  await payload.db.connection.db?.collection('application_bootstrap_locks').deleteMany({})
}

const createUser = async (
  role: Exclude<UserRole, 'owner'>,
  displayName: string,
): Promise<TestUser> => {
  const email = `${role}-${displayName.toLowerCase().replaceAll(' ', '-')}@example.test`

  return createDocument<TestUser>(
    'users',
    {
      active: true,
      displayName,
      email,
      password: PASSWORD,
      role,
      timezone: 'Pacific/Auckland',
    },
    { overrideAccess: false, req: ownerReq },
  )
}

describe.sequential('Payload authorization and domain integration', () => {
  beforeAll(async () => {
    let mongoURI: URL

    try {
      mongoURI = new URL(process.env.MONGODB_URI ?? '')
    } catch {
      throw new Error('Integration tests refuse to clean any database except local xero_time_test.')
    }

    if (
      mongoURI.protocol !== 'mongodb:' ||
      mongoURI.hostname !== 'localhost' ||
      mongoURI.port !== '27018' ||
      mongoURI.pathname !== '/xero_time_test'
    ) {
      throw new Error('Integration tests refuse to clean any database except local xero_time_test.')
    }

    payload = await getPayload({ config: await config })
    await clearCollections()

    const anonymousReq = await createLocalReq({}, payload)
    const firstUser = await registerFirstUserOperation({
      collection: payload.collections.users,
      data: {
        active: false,
        displayName: 'Integration Owner',
        email: OWNER_EMAIL,
        password: PASSWORD,
        role: 'member',
        timezone: 'Pacific/Auckland',
      } as never,
      req: anonymousReq,
    })

    if (!firstUser.user) throw new Error('Payload did not return the bootstrapped owner.')

    owner = firstUser.user as unknown as TestUser
    ownerReq = await requestFor(owner)
    admin = await createUser('admin', 'Integration Admin')
    biller = await createUser('biller', 'Integration Biller')
    member = await createUser('member', 'Integration Member')
    secondMember = await createUser('member', 'Second Member')
    adminReq = await requestFor(admin)
    billerReq = await requestFor(biller)
    memberReq = await requestFor(member)
    secondMemberReq = await requestFor(secondMember)
    trustedBillingReq = await createLocalReq(
      {
        context: {
          [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'reserve',
        },
      },
      payload,
    )
    trustedReleaseReq = await createLocalReq(
      {
        context: {
          [TIME_ENTRY_BILLING_MUTATION_CONTEXT]: 'release',
        },
      },
      payload,
    )

    customer = await createDocument<TestCustomer>(
      'customers',
      {
        billingEmail: 'accounts@primary.example.test',
        currency: ' nzd ',
        name: 'Primary Customer',
        notes: 'Financial team only',
      },
      { overrideAccess: false, req: ownerReq },
    )
    otherCustomer = await createDocument<TestCustomer>(
      'customers',
      {
        currency: 'NZD',
        name: 'Unrelated Customer',
      },
      { overrideAccess: false, req: ownerReq },
    )
    project = await createDocument<TestProject>(
      'projects',
      {
        billableByDefault: true,
        code: '  nz-core  ',
        currency: ' nzd ',
        customer: customer.id,
        hourlyRateScaled: 1_250_000,
        name: 'Core Integration Project',
      },
      { overrideAccess: false, req: ownerReq },
    )

    await createDocument<TestTimeEntry>(
      'time-entries',
      {
        billingStatus: 'exported',
        currencySnapshot: 'USD',
        customer: otherCustomer.id,
        customerNameSnapshot: 'Tampered customer',
        description: '  Implemented the integration boundary  ',
        durationSeconds: 60,
        enteredHours: 1,
        enteredMinutes: 30,
        inputMode: 'duration',
        owner: owner.id,
        project: project.id,
        projectCodeSnapshot: 'TAMPERED',
        projectNameSnapshot: 'Tampered project',
        rateSnapshotScaled: 1,
        timezone: 'Pacific/Auckland',
        workDate: '2026-07-18',
      },
      { overrideAccess: false, req: memberReq },
    ).then(async (entry) => {
      memberEntry = await findDocument<TestTimeEntry>('time-entries', entry.id, {
        overrideAccess: true,
      })
    })

    secondMemberEntry = await createDocument<TestTimeEntry>(
      'time-entries',
      {
        description: 'Second member entry',
        enteredHours: 0,
        enteredMinutes: 45,
        inputMode: 'duration',
        project: project.id,
        timezone: 'Pacific/Auckland',
        workDate: '2026-07-18',
      },
      { overrideAccess: false, req: secondMemberReq },
    )

    await updateDocument<TestTimeEntry>(
      'time-entries',
      memberEntry.id,
      {
        billingStatus: 'reserved',
        currentExport: owner.id,
        exportedAt: null,
        reservedAt: new Date().toISOString(),
      },
      { overrideAccess: true, req: trustedBillingReq },
    )
  }, 60_000)

  afterAll(async () => {
    if (!payload) return

    await clearCollections()
    await payload.destroy()
  })

  it('forces the first user to be an active owner', () => {
    expect(owner).toMatchObject({
      active: true,
      displayName: 'Integration Owner',
      email: OWNER_EMAIL,
      role: 'owner',
      timezone: 'Pacific/Auckland',
    })
    expect(owner).not.toHaveProperty('bootstrapMarker')
  })

  it('persists the hidden marker, atomic lock, and unique marker index', async () => {
    const initialOwner = (await payload.findByID({
      collection: 'users',
      id: owner.id,
      overrideAccess: true,
      showHiddenFields: true,
    })) as unknown as Record<string, unknown>
    const indexes = await requireMongoModel(payload, 'users').collection.indexes()
    const bootstrapLock = await payload.db.connection.db
      ?.collection<{ _id: string; createdAt: Date }>('application_bootstrap_locks')
      .findOne({ _id: 'initial-owner' })

    expect(initialOwner.bootstrapMarker).toBe('initial-owner')
    expect(bootstrapLock).toMatchObject({ _id: 'initial-owner' })
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { bootstrapMarker: 1 },
          sparse: true,
          unique: true,
        }),
      ]),
    )
  })

  it('denies every later anonymous user-creation path', async () => {
    const anonymousReq = await createLocalReq({}, payload)
    const data = {
      displayName: 'Anonymous User',
      email: 'anonymous@example.test',
      password: PASSWORD,
      timezone: 'Pacific/Auckland',
    }

    await expect(
      createDocument('users', data, { overrideAccess: false, req: anonymousReq }),
    ).rejects.toMatchObject({ status: 403 })

    await expect(
      registerFirstUserOperation({
        collection: payload.collections.users,
        data: data as never,
        req: anonymousReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('does not issue an email/password session to an inactive user', async () => {
    const inactiveEmail = 'inactive.integration@example.test'

    await createDocument(
      'users',
      {
        active: false,
        _verified: true,
        displayName: 'Inactive Integration User',
        email: inactiveEmail,
        password: PASSWORD,
        role: 'member',
        timezone: 'Pacific/Auckland',
      },
      { overrideAccess: false, req: ownerReq },
    )

    await expect(
      payload.login({
        collection: 'users',
        data: {
          email: inactiveEmail,
          password: PASSWORD,
        },
      }),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('requires eight characters on user creation and password changes', async () => {
    await expect(
      createDocument(
        'users',
        {
          active: true,
          displayName: 'Short Password User',
          email: 'short-password@example.test',
          password: 'short7!',
          role: 'member',
          timezone: 'Pacific/Auckland',
        },
        { overrideAccess: false, req: ownerReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      updateDocument(
        'users',
        member.id,
        { password: 'short7!' },
        { overrideAccess: false, req: ownerReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      createDocument(
        'users',
        {
          _verified: true,
          active: true,
          displayName: 'Minimum Password User',
          email: 'minimum-password@example.test',
          password: 'eight888',
          role: 'member',
          timezone: 'Pacific/Auckland',
        },
        { overrideAccess: false, req: ownerReq },
      ),
    ).resolves.toMatchObject({ email: 'minimum-password@example.test' })
  })

  it('allows only active owners and admins into Payload Admin', async () => {
    await expect(canAccessAdmin({ req: ownerReq })).resolves.toBeUndefined()
    await expect(canAccessAdmin({ req: adminReq })).resolves.toBeUndefined()
    await expect(canAccessAdmin({ req: billerReq })).rejects.toMatchObject({ status: 401 })
    await expect(canAccessAdmin({ req: memberReq })).rejects.toMatchObject({ status: 401 })
  })

  it('issues, rotates, accepts, resets, and revokes invite-only accounts safely', async () => {
    const ownerSession = { payload, req: ownerReq, user: owner } as unknown as AppSession
    const adminSession = { payload, req: adminReq, user: admin } as unknown as AppSession
    const invitationEmail = 'invited-lifecycle@example.test'
    const invitationPassword = 'invited-password-123!'
    const changedPassword = 'changed-password-456!'
    const resetPassword = 'reset-password-789!'
    const mailer = vi.fn(async () => undefined)

    await expect(
      issueInvitation(
        adminSession,
        {
          displayName: 'Forbidden Invited Admin',
          email: 'forbidden-invited-admin@example.test',
          role: 'admin',
          timezone: 'Pacific/Auckland',
        },
        mailer,
      ),
    ).rejects.toMatchObject({ code: 'invalid-role' })

    const firstIssue = await issueInvitation(
      ownerSession,
      {
        displayName: 'Invited Lifecycle User',
        email: invitationEmail,
        role: 'member',
        timezone: 'Australia/Sydney',
      },
      mailer,
    )
    const firstToken = new URL(firstIssue.setupURL).searchParams.get('token') ?? ''
    const firstStored = await payload.findByID({
      collection: 'invitations',
      depth: 0,
      id: firstIssue.invitation.id,
      overrideAccess: true,
      req: ownerReq,
      showHiddenFields: true,
    })
    expect(firstStored.tokenHash).not.toBe(firstToken)
    expect(JSON.stringify(firstStored)).not.toContain(firstToken)
    await expect(
      payload.find({ collection: 'invitations', overrideAccess: false, req: ownerReq }),
    ).rejects.toMatchObject({ status: 403 })

    const secondIssue = await issueInvitation(
      ownerSession,
      {
        displayName: 'Invited Lifecycle User',
        email: invitationEmail,
        role: 'member',
        timezone: 'Australia/Sydney',
      },
      mailer,
    )
    const secondToken = new URL(secondIssue.setupURL).searchParams.get('token') ?? ''
    expect(secondToken).not.toBe(firstToken)
    await expect(
      acceptInvitation(payload, { password: invitationPassword, token: firstToken }),
    ).rejects.toMatchObject({ code: 'invalid-invitation' })

    const acceptanceResults = await Promise.allSettled([
      acceptInvitation(payload, { password: invitationPassword, token: secondToken }),
      acceptInvitation(payload, { password: invitationPassword, token: secondToken }),
    ])
    expect(acceptanceResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(acceptanceResults.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const invitedUsers = await payload.find({
      collection: 'users',
      depth: 0,
      overrideAccess: true,
      where: { email: { equals: invitationEmail } },
    })
    expect(invitedUsers.docs).toHaveLength(1)
    const invitedUser = invitedUsers.docs[0]
    if (!invitedUser) throw new Error('Invitation acceptance did not create a user.')
    expect(invitedUser).toMatchObject({
      active: true,
      displayName: 'Invited Lifecycle User',
      role: 'member',
      timezone: 'Australia/Sydney',
    })
    await expect(
      acceptInvitation(payload, { password: invitationPassword, token: secondToken }),
    ).rejects.toMatchObject({ code: 'invalid-invitation' })

    const invitedReq = await createLocalReq(
      { user: { ...invitedUser, collection: 'users' } },
      payload,
    )
    const replacementToken = await changeOwnPassword(
      { payload, req: invitedReq, user: invitedUser } as unknown as AppSession,
      invitationPassword,
      changedPassword,
    )
    expect(replacementToken.length).toBeGreaterThan(20)
    await expect(
      payload.login({
        collection: 'users',
        data: { email: invitationEmail, password: invitationPassword },
      }),
    ).rejects.toBeDefined()
    await expect(
      payload.login({
        collection: 'users',
        data: { email: invitationEmail, password: changedPassword },
      }),
    ).resolves.toHaveProperty('token')

    await expect(
      payload.forgotPassword({
        collection: 'users',
        data: { email: invitationEmail },
        overrideAccess: true,
      }),
    ).rejects.toBeDefined()
    const directResetToken = await payload.forgotPassword({
      collection: 'users',
      data: { email: invitationEmail },
      disableEmail: true,
      overrideAccess: true,
    })
    expect(directResetToken).toBeTypeOf('string')
    const directResetPassword = 'direct-reset-password-567!'
    await payload.resetPassword({
      collection: 'users',
      data: { password: directResetPassword, token: directResetToken ?? '' },
      overrideAccess: true,
    })
    const directlyResetUser = await payload.findByID({
      collection: 'users',
      id: invitedUser.id,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect(directlyResetUser.sessions).toHaveLength(1)
    expect(directlyResetUser).toMatchObject({
      resetPasswordExpiration: null,
      resetPasswordToken: null,
    })

    const forgotToken = await payload.forgotPassword({
      collection: 'users',
      data: { email: invitationEmail },
      disableEmail: true,
      overrideAccess: true,
    })
    const resetSessionToken = await completePasswordReset(payload, forgotToken ?? '', resetPassword)
    expect(resetSessionToken.length).toBeGreaterThan(20)
    await expect(
      payload.login({
        collection: 'users',
        data: { email: invitationEmail, password: directResetPassword },
      }),
    ).rejects.toBeDefined()

    await payload.update({
      collection: 'users',
      id: invitedUser.id,
      data: { active: false },
      overrideAccess: false,
      req: ownerReq,
    })
    const deactivated = await payload.findByID({
      collection: 'users',
      depth: 0,
      id: invitedUser.id,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect(deactivated).toMatchObject({
      active: false,
      resetPasswordExpiration: null,
      resetPasswordToken: null,
      sessions: [],
    })
    await expect(
      payload.login({
        collection: 'users',
        data: { email: invitationEmail, password: resetPassword },
      }),
    ).rejects.toBeDefined()

    const revocable = await issueInvitation(
      ownerSession,
      {
        displayName: 'Revoked Invitation',
        email: 'revoked-invitation@example.test',
        role: 'biller',
        timezone: 'Pacific/Auckland',
      },
      mailer,
    )
    const revokedToken = new URL(revocable.setupURL).searchParams.get('token') ?? ''
    await revokeInvitation(ownerSession, String(revocable.invitation.id), 'No longer required.')
    await expect(
      acceptInvitation(payload, { password: invitationPassword, token: revokedToken }),
    ).rejects.toMatchObject({ code: 'invalid-invitation' })

    const [invitationIndexes, invitations] = await Promise.all([
      requireMongoModel(payload, 'invitations').collection.indexes(),
      payload.find({ collection: 'invitations', overrideAccess: true, pagination: false }),
    ])
    expect(invitationIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { email: 1 }, unique: true }),
        expect.objectContaining({ key: { tokenHash: 1 }, unique: true }),
        expect.objectContaining({ expireAfterSeconds: 0, key: { cleanupAt: 1 } }),
      ]),
    )
    expect(invitations.docs).toHaveLength(2)
    expect(mailer).toHaveBeenCalledTimes(3)
  })

  it('keeps owner records protected from deactivation, demotion, and deletion', async () => {
    const updated = await payload.update({
      collection: 'users',
      id: owner.id,
      data: { active: false, role: 'member' },
      overrideAccess: false,
      req: ownerReq,
    })
    expect(updated).toMatchObject({ active: true, role: 'owner' })
    await expect(
      payload.delete({
        collection: 'users',
        id: owner.id,
        overrideAccess: false,
        req: ownerReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('transitions ownership only through the audited password-capable command', async () => {
    const ownerSession = { payload, req: ownerReq, user: owner } as unknown as AppSession
    await expect(
      transitionOwner(ownerSession, {
        action: 'promote',
        password: 'incorrect-owner-password',
        reason: 'Verify that ownership changes require recent password confirmation.',
        targetUserID: String(admin.id),
      }),
    ).rejects.toMatchObject({ code: 'reauthentication-failed' })

    await expect(
      transitionOwner(ownerSession, {
        action: 'promote',
        password: PASSWORD,
        reason: 'Promote the tested administrator as a recovery-capable owner.',
        targetUserID: String(admin.id),
      }),
    ).resolves.toBeUndefined()
    const promoted = await payload.findByID({
      collection: 'users',
      depth: 0,
      id: admin.id,
      overrideAccess: true,
    })
    expect(promoted.role).toBe('owner')

    const parallelOwnerSession = {
      payload,
      req: await requestFor(owner),
      user: owner,
    } as unknown as AppSession
    const demotion = {
      action: 'demote' as const,
      password: PASSWORD,
      reason: 'Return the temporary recovery owner to administrator after verification.',
      targetUserID: String(admin.id),
    }
    const attempts = await Promise.allSettled([
      transitionOwner(ownerSession, demotion),
      transitionOwner(parallelOwnerSession, demotion),
    ])
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const restored = await payload.findByID({
      collection: 'users',
      depth: 0,
      id: admin.id,
      overrideAccess: true,
    })
    expect(restored.role).toBe('admin')
    const audits = await payload.find({
      collection: 'audit-events',
      depth: 0,
      overrideAccess: true,
      where: {
        and: [
          { eventType: { equals: 'user.owner-transitioned' } },
          { targetId: { equals: String(admin.id) } },
        ],
      },
    })
    expect(audits.docs).toHaveLength(2)
  })

  it('pins an explicitly selected Xero tenant, serializes refresh, and disconnects safely', async () => {
    const session = { payload, req: ownerReq, user: owner } as unknown as AppSession
    await expect(getAccountingConnectionView(session)).resolves.toMatchObject({
      callbackURI: 'http://localhost:3000/api/integrations/xero/accounting/callback',
      configured: false,
      status: 'not-configured',
    })
    await expect(
      configureAccountingOAuth(
        { payload, req: memberReq, user: member } as unknown as AppSession,
        accountingCredentials,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await configureAccountingOAuth(session, accountingCredentials)
    const storedRuntime = await resolveAccountingRuntime(session)
    const accountingConfig = storedRuntime.config
    expect(accountingConfig).toMatchObject({
      clientID: accountingCredentials.clientID,
      clientSecret: accountingCredentials.clientSecret,
      configured: true,
      redirectURI: 'http://localhost:3000/api/integrations/xero/accounting/callback',
      tokenEncryptionKeyVersion: 1,
    })
    expect(accountingConfig.tokenEncryptionKey).toMatch(/^[0-9a-f]{64}$/)
    await expect(getAccountingConnectionView(session)).resolves.toMatchObject({
      clientID: accountingCredentials.clientID,
      clientSecretConfigured: true,
      configured: true,
      status: 'disconnected',
    })
    const persistedConfiguration = (
      await payload.find({
        collection: 'xero-connections',
        depth: 0,
        overrideAccess: true,
        req: ownerReq,
        showHiddenFields: true,
      })
    ).docs[0]
    expect(persistedConfiguration?.oauthClientSecretEnvelope).not.toContain(
      accountingCredentials.clientSecret,
    )
    expect(JSON.stringify(persistedConfiguration)).not.toContain(accountingCredentials.clientSecret)

    const authenticationEventId = '11111111-1111-4111-8111-111111111111'
    const xeroUserId = '22222222-2222-4222-8222-222222222222'
    const connections = [
      {
        authEventId: authenticationEventId,
        connectionId: '33333333-3333-4333-8333-333333333333',
        tenantId: '44444444-4444-4444-8444-444444444444',
        tenantName: 'First Demo Company',
        tenantType: 'ORGANISATION' as const,
      },
      {
        authEventId: authenticationEventId,
        connectionId: '55555555-5555-4555-8555-555555555555',
        tenantId: '66666666-6666-4666-8666-666666666666',
        tenantName: 'Pinned Demo Company',
        tenantType: 'ORGANISATION' as const,
      },
    ]
    const initialTokenSet = {
      accessToken: 'plaintext-initial-access-token',
      expiresIn: 1_800,
      refreshToken: 'plaintext-initial-refresh-token',
      scopes: [...REQUIRED_ACCOUNTING_SCOPES],
    }
    const refreshedTokenSet = {
      accessToken: 'plaintext-refreshed-access-token',
      expiresIn: 1_800,
      refreshToken: 'plaintext-refreshed-refresh-token',
      scopes: [...REQUIRED_ACCOUNTING_SCOPES],
    }
    const refreshTokens = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return refreshedTokenSet
    })
    const deleteConnection = vi.fn(async () => undefined)
    const revokeRefreshToken = vi.fn(async () => undefined)
    const client: XeroAccountingClient = {
      accountingGet: vi.fn(async () => ({ data: {} })),
      accountingPost: vi.fn(async () => ({ data: {} })),
      deleteConnection,
      exchangeCode: vi.fn(async () => initialTokenSet),
      listConnections: vi.fn(async () => connections),
      refreshTokens,
      revokeRefreshToken,
    }
    const validateAccessToken = vi.fn(async (accessToken: string) => ({
      authenticationEventId,
      scopes: [...REQUIRED_ACCOUNTING_SCOPES],
      xeroUserId,
      ...(accessToken ? {} : { invalid: true }),
    }))
    const authorization = await createAccountingAuthorization(session, {
      config: accountingConfig,
    })
    const authorizationURL = new URL(authorization.authorizationURL)

    expect(authorizationURL.origin).toBe('https://login.xero.com')
    expect(authorizationURL.searchParams.get('redirect_uri')).toBe(accountingConfig.redirectURI)
    expect(authorizationURL.searchParams.get('scope')?.split(' ')).toEqual(
      REQUIRED_ACCOUNTING_SCOPES,
    )
    expect(authorizationURL.searchParams.get('scope')).not.toContain('openid')

    await expect(
      completeAccountingCallback(
        { payload, req: adminReq, user: admin } as unknown as AppSession,
        {
          browserBinding: authorization.browserBinding,
          code: 'wrong-user-code',
          state: authorizationURL.searchParams.get('state') ?? '',
        },
        { client, config: accountingConfig, validateAccessToken },
      ),
    ).rejects.toMatchObject({ code: 'invalid-state' })
    await expect(
      completeAccountingCallback(
        session,
        {
          browserBinding: 'different-browser-binding',
          code: 'wrong-browser-code',
          state: authorizationURL.searchParams.get('state') ?? '',
        },
        { client, config: accountingConfig, validateAccessToken },
      ),
    ).rejects.toMatchObject({ code: 'invalid-state' })
    expect(client.exchangeCode).not.toHaveBeenCalled()

    const callback = await completeAccountingCallback(
      session,
      {
        browserBinding: authorization.browserBinding,
        code: 'one-time-code',
        state: authorizationURL.searchParams.get('state') ?? '',
      },
      { client, config: accountingConfig, validateAccessToken },
    )
    expect(callback).toMatchObject({ status: 'select-tenant' })
    expect(callback.flowID).toBeTypeOf('string')

    const selection = await getAccountingTenantSelection(
      session,
      callback.flowID ?? '',
      authorization.browserBinding,
    )
    expect(selection.connections.map((connection) => connection.tenantName)).toEqual([
      'First Demo Company',
      'Pinned Demo Company',
    ])
    const selectedConnection = connections[1]
    if (!selectedConnection) throw new Error('The selected Xero fixture is unavailable.')
    const pendingState = await payload.findByID({
      collection: 'xero-oauth-states',
      id: callback.flowID ?? '',
      overrideAccess: true,
      req: ownerReq,
      showHiddenFields: true,
    })
    expect(JSON.stringify(pendingState)).not.toContain(initialTokenSet.accessToken)
    expect(JSON.stringify(pendingState)).not.toContain(initialTokenSet.refreshToken)

    await selectAccountingTenant(
      session,
      {
        browserBinding: authorization.browserBinding,
        flowID: callback.flowID ?? '',
        tenantID: selectedConnection.tenantId,
      },
      { config: accountingConfig },
    )

    const privateConnections = await payload.find({
      collection: 'xero-connections',
      depth: 0,
      overrideAccess: true,
      req: ownerReq,
      showHiddenFields: true,
    })
    const connection = privateConnections.docs[0]
    if (!connection) throw new Error('The Xero connection was not persisted.')
    expect(connection).toMatchObject({
      connectionId: selectedConnection.connectionId,
      status: 'connected',
      tenantId: selectedConnection.tenantId,
      tenantName: 'Pinned Demo Company',
      tokenVersion: 1,
    })
    expect(connection.accessTokenEnvelope).not.toContain(initialTokenSet.accessToken)
    expect(connection.refreshTokenEnvelope).not.toContain(initialTokenSet.refreshToken)
    await expect(
      configureAccountingOAuth(session, {
        clientID: 'replacement-accounting-client',
        clientSecret: 'replacement-accounting-secret',
      }),
    ).rejects.toMatchObject({ code: 'disconnect-before-config-change' })

    const connectionIndexes = await requireMongoModel(
      payload,
      'xero-connections',
    ).collection.indexes()
    const stateIndexes = await requireMongoModel(payload, 'xero-oauth-states').collection.indexes()
    expect(connectionIndexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: { singletonKey: 1 }, unique: true })]),
    )
    expect(stateIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { stateHash: 1 }, unique: true }),
        expect.objectContaining({ expireAfterSeconds: 0, key: { expiresAt: 1 } }),
      ]),
    )

    await expect(
      completeAccountingCallback(
        session,
        {
          browserBinding: authorization.browserBinding,
          code: 'replayed-code',
          state: authorizationURL.searchParams.get('state') ?? '',
        },
        { client, config: accountingConfig, validateAccessToken },
      ),
    ).rejects.toMatchObject({ code: 'invalid-state' })

    await expect(
      payload.find({
        collection: 'xero-connections',
        overrideAccess: false,
        req: ownerReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.find({
        collection: 'xero-oauth-states',
        overrideAccess: false,
        req: ownerReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.create({
        collection: 'xero-connections',
        data: { singletonKey: 'owner-created', status: 'disconnected', tokenVersion: 0 },
        overrideAccess: false,
        req: ownerReq,
      }),
    ).rejects.toMatchObject({ status: 403 })

    await payload.update({
      collection: 'xero-connections',
      id: connection.id,
      data: { accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() },
      overrideAccess: true,
      req: ownerReq,
    })
    // Concurrent HTTP requests never share a mutable Payload request object.
    // Use independent requests here while exercising the shared database lock.
    const firstRefreshSession = {
      payload,
      req: await requestFor(owner),
      user: owner,
    } as unknown as AppSession
    const secondRefreshSession = {
      payload,
      req: await requestFor(owner),
      user: owner,
    } as unknown as AppSession
    const accessResults = await Promise.all([
      getValidAccountingAccessToken(firstRefreshSession, {
        client,
        config: accountingConfig,
        validateAccessToken,
      }),
      getValidAccountingAccessToken(secondRefreshSession, {
        client,
        config: accountingConfig,
        validateAccessToken,
      }),
    ])
    expect(accessResults.map((result) => result.accessToken)).toEqual([
      refreshedTokenSet.accessToken,
      refreshedTokenSet.accessToken,
    ])
    expect(refreshTokens).toHaveBeenCalledTimes(1)

    await expect(
      checkAccountingConnectionHealth(session, {
        client,
        config: accountingConfig,
        validateAccessToken,
      }),
    ).resolves.toMatchObject({ status: 'connected', tenantId: selectedConnection.tenantId })

    await expect(
      disconnectAccountingConnection(session, 'Integration test disconnect reason.', {
        client,
        config: accountingConfig,
        validateAccessToken,
      }),
    ).resolves.toEqual({ remoteCleanupComplete: true })
    expect(deleteConnection).toHaveBeenCalledWith(
      refreshedTokenSet.accessToken,
      selectedConnection.connectionId,
    )
    expect(revokeRefreshToken).toHaveBeenCalledWith(refreshedTokenSet.refreshToken)

    const disconnected = await payload.findByID({
      collection: 'xero-connections',
      id: connection.id,
      overrideAccess: true,
      req: ownerReq,
      showHiddenFields: true,
    })
    expect(disconnected).toMatchObject({
      accessTokenEnvelope: null,
      connectionId: selectedConnection.connectionId,
      refreshTokenEnvelope: null,
      status: 'disconnected',
      tenantId: selectedConnection.tenantId,
    })
    await configureAccountingOAuth(session, {
      clientID: accountingCredentials.clientID,
      clientSecret: '',
    })
    await expect(resolveAccountingRuntime(session)).resolves.toMatchObject({
      config: {
        clientID: accountingCredentials.clientID,
        clientSecret: accountingCredentials.clientSecret,
      },
    })
    const configurationAudits = await payload.find({
      collection: 'audit-events',
      depth: 0,
      overrideAccess: true,
      where: {
        and: [
          { eventType: { equals: 'xero.accounting-configuration-changed' } },
          { targetId: { equals: String(connection.id) } },
        ],
      },
    })
    expect(configurationAudits.docs).toHaveLength(2)
    expect(JSON.stringify(configurationAudits.docs)).not.toContain(
      accountingCredentials.clientSecret,
    )
  })

  it('lets a member update their own profile without changing privileges or entry snapshots', async () => {
    const updated = await updateDocument<TestUser>(
      'users',
      member.id,
      {
        active: false,
        displayName: 'Updated Integration Member',
        role: 'owner',
        timezone: 'Australia/Sydney',
      },
      { overrideAccess: false, req: memberReq },
    )
    const existingEntry = await findDocument<TestTimeEntry>('time-entries', memberEntry.id, {
      overrideAccess: true,
    })

    expect(updated).toMatchObject({
      active: true,
      displayName: 'Updated Integration Member',
      role: 'member',
      timezone: 'Australia/Sydney',
    })
    expect(existingEntry.timezone).toBe('Pacific/Auckland')

    await expect(
      updateDocument(
        'users',
        member.id,
        { displayName: 'Changed by another member' },
        { overrideAccess: false, req: secondMemberReq },
      ),
    ).rejects.toMatchObject({ status: 403 })

    await updateDocument(
      'users',
      member.id,
      { displayName: member.displayName, timezone: member.timezone },
      { overrideAccess: false, req: memberReq },
    )
  })

  it('keeps customer and project management privileged and hides rates from members', async () => {
    await expect(
      createDocument(
        'customers',
        { currency: 'NZD', name: 'Member Customer' },
        { overrideAccess: false, req: memberReq },
      ),
    ).rejects.toMatchObject({ status: 403 })

    await expect(
      createDocument(
        'projects',
        {
          code: 'MEMBER',
          currency: 'NZD',
          customer: customer.id,
          hourlyRateScaled: 500_000,
          name: 'Member Project',
        },
        { overrideAccess: false, req: memberReq },
      ),
    ).rejects.toMatchObject({ status: 403 })

    const ownerView = await findDocument<TestProject>('projects', project.id, {
      overrideAccess: false,
      req: ownerReq,
    })
    const memberView = await findDocument<TestProject>('projects', project.id, {
      overrideAccess: false,
      req: memberReq,
    })

    expect(ownerView.hourlyRateScaled).toBe(1_250_000)
    expect(memberView).not.toHaveProperty('hourlyRateScaled')

    const ownerCustomerView = await findDocument<TestCustomer>('customers', customer.id, {
      overrideAccess: false,
      req: ownerReq,
    })
    const memberCustomerView = await findDocument<TestCustomer>('customers', customer.id, {
      overrideAccess: false,
      req: memberReq,
    })

    expect(ownerCustomerView).toMatchObject({
      billingEmail: 'accounts@primary.example.test',
      notes: 'Financial team only',
    })
    expect(memberCustomerView).not.toHaveProperty('billingEmail')
    expect(memberCustomerView).not.toHaveProperty('notes')
  })

  it('normalizes currency and project code while rejecting cross-currency projects', async () => {
    expect(customer.currency).toBe('NZD')
    expect(project).toMatchObject({
      code: 'NZ-CORE',
      currency: 'NZD',
      hourlyRateScaled: 1_250_000,
    })
    expect(relationshipID(project.customer)).toBe(customer.id)

    await expect(
      createDocument(
        'projects',
        {
          code: 'WRONG-CURRENCY',
          currency: 'USD',
          customer: customer.id,
          hourlyRateScaled: 1_000_000,
          name: 'Wrong Currency',
        },
        { overrideAccess: false, req: ownerReq },
      ),
    ).rejects.toMatchObject({
      data: {
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('NZD'),
            path: 'currency',
          }),
        ]),
      },
      status: 400,
    })

    await expect(
      updateDocument(
        'customers',
        customer.id,
        { currency: 'USD' },
        { overrideAccess: false, req: ownerReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      updateDocument(
        'customers',
        customer.id,
        { currency: 'USD' },
        { overrideAccess: false, req: ownerReq },
      ),
    ).rejects.toMatchObject({
      data: {
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('Currency cannot change'),
            path: 'currency',
          }),
        ]),
      },
      status: 400,
    })
  })

  it('derives protected duration-entry ownership and immutable billing snapshots', () => {
    expect(memberEntry).toMatchObject({
      billingStatus: 'unbilled',
      currencySnapshot: 'NZD',
      customerNameSnapshot: 'Primary Customer',
      durationSeconds: 5_400,
      projectCodeSnapshot: 'NZ-CORE',
      projectNameSnapshot: 'Core Integration Project',
      rateSnapshotScaled: 1_250_000,
    })
    expect(relationshipID(memberEntry.owner)).toBe(member.id)
    expect(relationshipID(memberEntry.customer)).toBe(customer.id)
  })

  it('restricts members to their own time entries', async () => {
    const memberEntries = await findDocuments<TestTimeEntry>('time-entries', {
      overrideAccess: false,
      req: memberReq,
    })
    const secondMemberEntries = await findDocuments<TestTimeEntry>('time-entries', {
      overrideAccess: false,
      req: secondMemberReq,
    })
    const ownerEntries = await findDocuments<TestTimeEntry>('time-entries', {
      overrideAccess: false,
      req: ownerReq,
    })

    expect(memberEntries.map((entry) => entry.id)).toEqual([memberEntry.id])
    expect(secondMemberEntries.map((entry) => entry.id)).toEqual([secondMemberEntry.id])
    expect(ownerEntries.map((entry) => entry.id).sort()).toEqual(
      [memberEntry.id, secondMemberEntry.id].sort(),
    )

    await expect(
      updateDocument(
        'time-entries',
        secondMemberEntry.id,
        { description: 'Member tried to edit another user entry' },
        { overrideAccess: false, req: memberReq },
      ),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('keeps an existing rate snapshot when an unchanged project is resubmitted', async () => {
    await updateDocument(
      'projects',
      project.id,
      {
        commercialChangeReason: 'Integration test commercial rate change.',
        confirmUnbilledImpact: true,
        hourlyRateScaled: 2_000_000,
      },
      { overrideAccess: false, req: ownerReq },
    )

    await updateDocument<TestTimeEntry>(
      'time-entries',
      secondMemberEntry.id,
      {
        description: 'Description changed after the project rate',
        project: project.id,
      },
      { overrideAccess: false, req: secondMemberReq },
    )
    const createdEntry = await createDocument<TestTimeEntry>(
      'time-entries',
      {
        description: 'Created after the project rate changed',
        enteredHours: 1,
        enteredMinutes: 0,
        inputMode: 'duration',
        project: project.id,
        timezone: 'Pacific/Auckland',
        workDate: '2026-07-19',
      },
      { overrideAccess: false, req: secondMemberReq },
    )
    postRateEntry = createdEntry
    const existingEntry = await findDocument<TestTimeEntry>('time-entries', secondMemberEntry.id, {
      overrideAccess: true,
    })
    const newEntry = await findDocument<TestTimeEntry>('time-entries', createdEntry.id, {
      overrideAccess: true,
    })

    expect(existingEntry.rateSnapshotScaled).toBe(1_250_000)
    expect(newEntry.rateSnapshotScaled).toBe(2_000_000)

    await updateDocument(
      'projects',
      project.id,
      {
        commercialChangeReason: 'Restore integration test project rate.',
        confirmUnbilledImpact: true,
        hourlyRateScaled: 1_250_000,
      },
      { overrideAccess: false, req: ownerReq },
    )
  })

  it('recalculates only changed unbilled rate snapshots with preview and audit', async () => {
    await updateDocument(
      'projects',
      project.id,
      {
        commercialChangeReason: 'Set a new integration rate for explicit recalculation.',
        confirmUnbilledImpact: true,
        hourlyRateScaled: 1_500_000,
      },
      { overrideAccess: false, req: ownerReq },
    )
    const ownerSession = { payload, req: ownerReq, user: owner } as unknown as AppSession
    const memberSession = { payload, req: memberReq, user: member } as unknown as AppSession
    await expect(
      previewProjectRateRecalculation(memberSession, String(project.id)),
    ).rejects.toThrow('Only an owner or administrator')
    const preview = await previewProjectRateRecalculation(ownerSession, String(project.id))
    expect(preview).toMatchObject({ affectedCount: 2, currentRateScaled: 1_500_000 })
    await expect(
      confirmProjectRateRecalculation(ownerSession, {
        confirmation: 'RECALCULATE',
        expectedHash: 'stale-preview-hash',
        projectID: String(project.id),
        reason: 'Apply the approved project rate to unbilled integration entries.',
      }),
    ).rejects.toThrow('changed')
    await expect(
      confirmProjectRateRecalculation(ownerSession, {
        confirmation: 'RECALCULATE',
        expectedHash: preview.hash,
        projectID: String(project.id),
        reason: 'Apply the approved project rate to unbilled integration entries.',
      }),
    ).resolves.toBe(2)

    const reserved = await findDocument<TestTimeEntry>('time-entries', memberEntry.id, {
      overrideAccess: true,
    })
    const recalculated = await Promise.all([
      findDocument<TestTimeEntry>('time-entries', secondMemberEntry.id, { overrideAccess: true }),
      findDocument<TestTimeEntry>('time-entries', postRateEntry.id, { overrideAccess: true }),
    ])
    expect(reserved.rateSnapshotScaled).toBe(1_250_000)
    expect(recalculated.every((entry) => entry.rateSnapshotScaled === 1_500_000)).toBe(true)
    const audits = await payload.find({
      collection: 'audit-events',
      depth: 0,
      overrideAccess: true,
      where: {
        and: [
          { eventType: { equals: 'time-entry.rate-recalculated' } },
          { targetId: { equals: String(project.id) } },
        ],
      },
    })
    expect(audits.docs).toHaveLength(1)

    await updateDocument(
      'projects',
      project.id,
      {
        commercialChangeReason: 'Restore the project rate after recalculation coverage.',
        confirmUnbilledImpact: true,
        hourlyRateScaled: 1_250_000,
      },
      { overrideAccess: false, req: ownerReq },
    )
  })

  it('requires and audits privileged time corrections and deletions', async () => {
    await expect(
      updateDocument(
        'time-entries',
        secondMemberEntry.id,
        { description: 'Owner correction without a reason.' },
        { overrideAccess: false, req: ownerReq },
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      updateDocument<TestTimeEntry>(
        'time-entries',
        secondMemberEntry.id,
        {
          description: 'Corrected by the owner with an audit reason.',
          privilegedCorrectionReason: 'Correct the integration entry description after review.',
        },
        { overrideAccess: false, req: ownerReq },
      ),
    ).resolves.toMatchObject({ description: 'Corrected by the owner with an audit reason.' })

    const ownerSession = { payload, req: ownerReq, user: owner } as unknown as AppSession
    const lockedAuditBefore = await payload.count({
      collection: 'audit-events',
      overrideAccess: true,
      where: { targetId: { equals: String(memberEntry.id) } },
    })
    await expect(
      deleteUnbilledTimeEntryAsAdministrator(ownerSession, {
        entryID: String(memberEntry.id),
        reason: 'Attempt to delete locked integration time should roll back.',
      }),
    ).rejects.toThrow('Reserved or exported time cannot be deleted')
    const lockedAuditAfter = await payload.count({
      collection: 'audit-events',
      overrideAccess: true,
      where: { targetId: { equals: String(memberEntry.id) } },
    })
    expect(lockedAuditAfter.totalDocs).toBe(lockedAuditBefore.totalDocs)

    await deleteUnbilledTimeEntryAsAdministrator(ownerSession, {
      entryID: String(secondMemberEntry.id),
      reason: 'Remove the obsolete integration entry after correction review.',
    })
    await expect(
      payload.findByID({
        collection: 'time-entries',
        id: secondMemberEntry.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ status: 404 })
    const correctionAudits = await payload.find({
      collection: 'audit-events',
      depth: 0,
      overrideAccess: true,
      where: {
        and: [
          { eventType: { equals: 'time-entry.privileged-correction' } },
          { targetId: { equals: String(secondMemberEntry.id) } },
        ],
      },
    })
    expect(correctionAudits.docs).toHaveLength(2)
  })

  it('derives a minute-precise range duration and local work date', async () => {
    const entry = await createDocument<TestTimeEntry>(
      'time-entries',
      {
        description: 'Crossed local midnight',
        endAt: '2026-07-18T13:30:00.000Z',
        inputMode: 'range',
        project: project.id,
        startAt: '2026-07-18T12:00:00.000Z',
        timezone: 'Pacific/Auckland',
      },
      { overrideAccess: false, req: memberReq },
    )

    expect(entry).toMatchObject({
      durationSeconds: 5_400,
      endAt: '2026-07-18T13:30:00.000Z',
      startAt: '2026-07-18T12:00:00.000Z',
      workDate: '2026-07-19',
    })
  })

  it('rejects zero, over-24-hour, and fractional-minute input', async () => {
    const durationInput = {
      description: 'Invalid duration',
      inputMode: 'duration',
      project: project.id,
      timezone: 'Pacific/Auckland',
      workDate: '2026-07-19',
    }

    await expect(
      createDocument(
        'time-entries',
        { ...durationInput, enteredHours: 0, enteredMinutes: 0 },
        { overrideAccess: false, req: memberReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      createDocument(
        'time-entries',
        { ...durationInput, enteredHours: 24, enteredMinutes: 1 },
        { overrideAccess: false, req: memberReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      createDocument(
        'time-entries',
        {
          description: 'Invalid range precision',
          endAt: '2026-07-18T13:30:00.000Z',
          inputMode: 'range',
          project: project.id,
          startAt: '2026-07-18T12:00:01.000Z',
          timezone: 'Pacific/Auckland',
        },
        { overrideAccess: false, req: memberReq },
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('prevents generic update or deletion after an entry is reserved', async () => {
    await expect(
      updateDocument(
        'time-entries',
        memberEntry.id,
        { description: 'Member tried to change locked time' },
        { overrideAccess: false, req: memberReq },
      ),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      updateDocument(
        'time-entries',
        memberEntry.id,
        { description: 'Owner tried to change locked time' },
        { overrideAccess: false, req: ownerReq },
      ),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      deleteDocument('time-entries', memberEntry.id, {
        overrideAccess: false,
        req: memberReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      updateDocument(
        'time-entries',
        memberEntry.id,
        { description: 'overrideAccess alone cannot bypass the billing lock' },
        { overrideAccess: true },
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      deleteDocument('time-entries', memberEntry.id, {
        overrideAccess: true,
        req: trustedBillingReq,
      }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      updateDocument(
        'time-entries',
        memberEntry.id,
        {
          billingStatus: 'unbilled',
          description: 'A billing context must not change ordinary entry data',
          exportedAt: null,
          reservedAt: null,
        },
        { overrideAccess: true, req: trustedReleaseReq },
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      deleteDocument('time-entries', memberEntry.id, {
        overrideAccess: false,
        req: ownerReq,
      }),
    ).rejects.toMatchObject({ status: 403 })

    const lockedEntry = await findDocument<TestTimeEntry>('time-entries', memberEntry.id, {
      overrideAccess: true,
    })
    expect(lockedEntry.billingStatus).toBe('reserved')

    await expect(
      updateDocument(
        'time-entries',
        memberEntry.id,
        {
          billingStatus: 'unbilled',
          currentExport: null,
          exportedAt: null,
          reservedAt: null,
        },
        { overrideAccess: true, req: trustedReleaseReq },
      ),
    ).resolves.toMatchObject({ billingStatus: 'unbilled' })
  })

  it('enforces role boundaries on all three settings globals', async () => {
    await expect(
      updateGlobal('business-settings', { businessName: 'Owner Business' }, ownerReq),
    ).resolves.toMatchObject({ businessName: 'Owner Business' })
    await expect(
      updateGlobal('business-settings', { businessName: 'Admin Business' }, adminReq),
    ).resolves.toMatchObject({ businessName: 'Admin Business' })
    await expect(findGlobal('business-settings', memberReq)).resolves.toMatchObject({
      businessName: 'Admin Business',
    })
    await expect(findGlobal('business-settings', billerReq)).resolves.toBeDefined()
    await expect(
      updateGlobal('business-settings', { businessName: 'Member Business' }, memberReq),
    ).rejects.toMatchObject({ status: 403 })

    await expect(
      updateGlobal('authentication-settings', { staleAccountingHealthCheckHours: 12 }, ownerReq),
    ).resolves.toMatchObject({ staleAccountingHealthCheckHours: 12 })
    const authenticationBefore = await findGlobal<AuthenticationSetting>(
      'authentication-settings',
      ownerReq,
    )
    const identityTarget = authenticationBefore.xeroIdentityLoginEnabled !== true
    await expect(
      updateGlobal(
        'authentication-settings',
        { xeroIdentityLoginEnabled: identityTarget },
        ownerReq,
      ),
    ).resolves.toMatchObject({ xeroIdentityLoginEnabled: identityTarget })
    await expect(
      updateGlobal(
        'authentication-settings',
        {
          xeroIdentityLoginEnabled: authenticationBefore.xeroIdentityLoginEnabled === true,
        },
        ownerReq,
      ),
    ).resolves.toMatchObject({
      xeroIdentityLoginEnabled: authenticationBefore.xeroIdentityLoginEnabled === true,
    })
    await expect(findGlobal('authentication-settings', adminReq)).resolves.toBeDefined()
    await expect(findGlobal('authentication-settings', memberReq)).rejects.toMatchObject({
      status: 403,
    })
    await expect(findGlobal('authentication-settings', billerReq)).rejects.toMatchObject({
      status: 403,
    })

    await expect(
      updateGlobal('billing-settings', { invoiceReferencePrefix: ' TEST- ' }, adminReq),
    ).resolves.toMatchObject({ invoiceReferencePrefix: 'TEST-' })
    const billingBefore = await findGlobal<BillingSetting>('billing-settings', ownerReq)
    const processingTarget = billingBefore.processingEnabled !== true
    await expect(
      updateGlobal('billing-settings', { processingEnabled: processingTarget }, ownerReq),
    ).resolves.toMatchObject({ processingEnabled: processingTarget })
    await expect(
      updateGlobal(
        'billing-settings',
        {
          processingEnabled: billingBefore.processingEnabled === true,
        },
        ownerReq,
      ),
    ).resolves.toMatchObject({ processingEnabled: billingBefore.processingEnabled === true })
    await expect(findGlobal('billing-settings', ownerReq)).resolves.toBeDefined()
    await expect(findGlobal('billing-settings', billerReq)).resolves.toBeDefined()
    await expect(
      updateGlobal('billing-settings', { invoiceReferencePrefix: 'BILLER-' }, billerReq),
    ).rejects.toMatchObject({ status: 403 })
    await expect(findGlobal('billing-settings', memberReq)).rejects.toMatchObject({ status: 403 })
  })

  it('limits collection and global version history to owners and admins', async () => {
    await expect(
      payload.findVersions({
        collection: 'time-entries',
        overrideAccess: false,
        req: memberReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.findVersions({
        collection: 'time-entries',
        overrideAccess: false,
        req: ownerReq,
      }),
    ).resolves.toMatchObject({ totalDocs: expect.any(Number) })

    await expect(
      payload.findGlobalVersions({
        slug: 'billing-settings',
        overrideAccess: false,
        req: billerReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.findGlobalVersions({
        slug: 'billing-settings',
        overrideAccess: false,
        req: adminReq,
      }),
    ).resolves.toMatchObject({ totalDocs: expect.any(Number) })
  })

  it('rejects new time when the project customer is archived', async () => {
    await updateDocument<TestCustomer>(
      'customers',
      customer.id,
      { status: 'archived' },
      { overrideAccess: false, req: ownerReq },
    )

    await expect(
      updateDocument(
        'projects',
        project.id,
        { description: 'The project remains editable after its customer is archived.' },
        { overrideAccess: false, req: ownerReq },
      ),
    ).resolves.toMatchObject({ id: project.id })

    await expect(
      createDocument(
        'time-entries',
        {
          description: 'Should not be accepted',
          enteredHours: 1,
          enteredMinutes: 0,
          inputMode: 'duration',
          project: project.id,
          timezone: 'Pacific/Auckland',
          workDate: '2026-07-19',
        },
        { overrideAccess: false, req: memberReq },
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('commits writes made through withPayloadTransaction', async () => {
    const committedName = 'Committed Customer'

    await withPayloadTransaction(
      payload,
      async (req) => {
        const committedCustomer = await createDocument<TestCustomer>(
          'customers',
          { currency: 'NZD', name: committedName },
          { overrideAccess: false, req },
        )
        await createDocument(
          'projects',
          {
            code: 'TX-COMMIT',
            currency: 'NZD',
            customer: committedCustomer.id,
            hourlyRateScaled: 750_000,
            name: 'Committed Project',
          },
          { overrideAccess: false, req },
        )
      },
      { user: { ...owner, collection: 'users' } as never },
    )

    const matches = await payload.find({
      collection: 'customers' as never,
      depth: 0,
      overrideAccess: true,
      where: {
        name: {
          equals: committedName,
        },
      },
    })

    expect(matches.totalDocs).toBe(1)
    const projects = await payload.find({
      collection: 'projects' as never,
      depth: 0,
      overrideAccess: true,
      where: {
        code: {
          equals: 'TX-COMMIT',
        },
      },
    })
    expect(projects.totalDocs).toBe(1)
  })

  it('rolls back every write when withPayloadTransaction throws', async () => {
    const rolledBackName = 'Rolled Back Customer'

    await expect(
      withPayloadTransaction(
        payload,
        async (req) => {
          const rolledBackCustomer = await createDocument<TestCustomer>(
            'customers',
            { currency: 'NZD', name: rolledBackName },
            { overrideAccess: false, req },
          )
          await createDocument(
            'projects',
            {
              code: 'TX-ROLLBACK',
              currency: 'NZD',
              customer: rolledBackCustomer.id,
              hourlyRateScaled: 800_000,
              name: 'Rolled Back Project',
            },
            { overrideAccess: false, req },
          )
          throw new Error('force rollback')
        },
        { user: { ...owner, collection: 'users' } as never },
      ),
    ).rejects.toThrow('force rollback')

    const matches = await payload.find({
      collection: 'customers' as never,
      depth: 0,
      overrideAccess: true,
      where: {
        name: {
          equals: rolledBackName,
        },
      },
    })

    expect(matches.totalDocs).toBe(0)
    const projects = await payload.find({
      collection: 'projects' as never,
      depth: 0,
      overrideAccess: true,
      where: {
        code: {
          equals: 'TX-ROLLBACK',
        },
      },
    })
    expect(projects.totalDocs).toBe(0)
  })
})
