// @vitest-environment node

import {
  canAccessAdmin,
  createLocalReq,
  generatePayloadCookie,
  getPayload,
  registerFirstUserOperation,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { TIME_ENTRY_BILLING_MUTATION_CONTEXT } from '@/collections/TimeEntries'
import { changeOwnPassword, completePasswordReset } from '@/lib/account-lifecycle/service'
import { getAppSessionForOAuthCallback, type AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import {
  confirmProjectRateRecalculation,
  previewProjectRateRecalculation,
} from '@/lib/projects/rate-recalculation'
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
import config from '@/payload.config'

type DocumentID = number | string

type TestUser = {
  collection?: 'users'
  displayName: string
  email: string
  id: DocumentID
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
  description?: string
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

const USER_EMAIL = 'user.integration@example.test'
const PASSWORD = 'integration-password-123!'
const accountingCredentials = {
  clientID: 'integration-accounting-client',
  clientSecret: 'integration-accounting-secret',
} as const

let payload: Payload
let user: TestUser
let userReq: PayloadRequest
let anonymousReq: PayloadRequest
let trustedBillingReq: PayloadRequest
let trustedReleaseReq: PayloadRequest
let customer: TestCustomer
let otherCustomer: TestCustomer
let project: TestProject
let reservedEntry: TestTimeEntry
let unbilledEntry: TestTimeEntry
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

const requestFor = (account: TestUser): Promise<PayloadRequest> =>
  createLocalReq(
    {
      user: {
        ...account,
        collection: 'users',
      } as never,
    },
    payload,
  )

const sessionFor = async (account: TestUser): Promise<AppSession> =>
  ({ payload, req: await requestFor(account), user: account }) as unknown as AppSession

const clearCollections = async (): Promise<void> => {
  for (const collection of [
    'xero-oauth-states',
    'xero-connections',
    'time-entries',
    'projects',
    'customers',
    'users',
  ]) {
    await payload.db.collections[collection]?.deleteMany({})
    await payload.db.versions[collection]?.deleteMany({})
  }
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

    // registerFirstUser signs the new user into the request it is given, so the
    // bootstrap request must not be reused as the anonymous request.
    const firstUser = await registerFirstUserOperation({
      collection: payload.collections.users,
      data: {
        displayName: 'Integration User',
        email: USER_EMAIL,
        password: PASSWORD,
        timezone: 'Pacific/Auckland',
      } as never,
      req: await createLocalReq({}, payload),
    })

    if (!firstUser.user) throw new Error('Payload did not return the first user.')

    user = firstUser.user as unknown as TestUser
    userReq = await requestFor(user)
    anonymousReq = await createLocalReq({}, payload)
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
      { overrideAccess: false, req: userReq },
    )
    otherCustomer = await createDocument<TestCustomer>(
      'customers',
      {
        currency: 'NZD',
        name: 'Unrelated Customer',
      },
      { overrideAccess: false, req: userReq },
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
      { overrideAccess: false, req: userReq },
    )

    // System-derived fields submitted by an ordinary request are ignored.
    const tamperedEntry = await createDocument<TestTimeEntry>(
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
        project: project.id,
        projectCodeSnapshot: 'TAMPERED',
        projectNameSnapshot: 'Tampered project',
        rateSnapshotScaled: 1,
        timezone: 'Pacific/Auckland',
        workDate: '2026-07-18',
      },
      { overrideAccess: false, req: userReq },
    )
    reservedEntry = await findDocument<TestTimeEntry>('time-entries', tamperedEntry.id, {
      overrideAccess: true,
    })

    unbilledEntry = await createDocument<TestTimeEntry>(
      'time-entries',
      {
        description: 'Unbilled integration entry',
        enteredHours: 0,
        enteredMinutes: 45,
        inputMode: 'duration',
        project: project.id,
        timezone: 'Pacific/Auckland',
        workDate: '2026-07-18',
      },
      { overrideAccess: false, req: userReq },
    )

    await updateDocument<TestTimeEntry>(
      'time-entries',
      reservedEntry.id,
      {
        billingStatus: 'reserved',
        currentExport: user.id,
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

  it('authenticates a state-protected OAuth callback from a cross-site session cookie', async () => {
    await expect(getAppSessionForOAuthCallback(new Headers())).resolves.toBeNull()
    await expect(
      getAppSessionForOAuthCallback(
        new Headers({
          Cookie: `${payload.config.cookiePrefix}-token=%00%0Dmalformed`,
        }),
      ),
    ).resolves.toBeNull()

    const login = await payload.login({
      collection: 'users',
      data: { email: USER_EMAIL, password: PASSWORD },
    })
    if (!login.token) throw new Error('Payload did not return a session token.')

    const authConfig = payload.collections.users.config.auth
    if (!authConfig) throw new Error('The users collection is not configured for authentication.')
    const cookie = generatePayloadCookie({
      collectionAuthConfig: authConfig,
      cookiePrefix: payload.config.cookiePrefix,
      returnCookieAsObject: true,
      token: login.token,
    })
    const crossSiteHeaders = new Headers({
      Cookie: `${cookie.name}=${cookie.value}`,
      'Sec-Fetch-Site': 'cross-site',
    })

    await expect(payload.auth({ headers: crossSiteHeaders })).resolves.toMatchObject({ user: null })
    const callbackHeaders = new Headers(crossSiteHeaders)
    callbackHeaders.set('Authorization', 'JWT untrusted-caller-value')
    callbackHeaders.set('Origin', 'https://untrusted.example')

    await expect(getAppSessionForOAuthCallback(callbackHeaders)).resolves.toMatchObject({
      user: { id: user.id },
    })
  })

  it('denies anonymous user creation once the first user exists', async () => {
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

  it('opens the app and Payload Admin to the signed-in user and denies anonymous requests', async () => {
    await expect(canAccessAdmin({ req: userReq })).resolves.toBeUndefined()
    await expect(canAccessAdmin({ req: anonymousReq })).rejects.toMatchObject({ status: 401 })

    const entries = await findDocuments<TestTimeEntry>('time-entries', {
      overrideAccess: false,
      req: userReq,
    })
    expect(entries.map((entry) => String(entry.id)).sort()).toEqual(
      [String(reservedEntry.id), String(unbilledEntry.id)].sort(),
    )
    const userProjectView = await findDocument<TestProject>('projects', project.id, {
      overrideAccess: false,
      req: userReq,
    })
    expect(userProjectView.hourlyRateScaled).toBe(1_250_000)
    await expect(
      findDocument<TestCustomer>('customers', customer.id, {
        overrideAccess: false,
        req: userReq,
      }),
    ).resolves.toMatchObject({
      billingEmail: 'accounts@primary.example.test',
      notes: 'Financial team only',
    })

    for (const collection of ['customers', 'projects', 'time-entries', 'users']) {
      await expect(
        findDocuments(collection, { overrideAccess: false, req: anonymousReq }),
      ).rejects.toMatchObject({ status: 403 })
    }
    await expect(
      createDocument(
        'customers',
        { currency: 'NZD', name: 'Anonymous Customer' },
        { overrideAccess: false, req: anonymousReq },
      ),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      createDocument(
        'time-entries',
        {
          description: 'Anonymous time',
          enteredHours: 1,
          enteredMinutes: 0,
          inputMode: 'duration',
          project: project.id,
          timezone: 'Pacific/Auckland',
          workDate: '2026-07-19',
        },
        { overrideAccess: false, req: anonymousReq },
      ),
    ).rejects.toMatchObject({ status: 403 })
    for (const slug of ['business-settings', 'billing-settings']) {
      await expect(findGlobal(slug, anonymousReq)).rejects.toMatchObject({ status: 403 })
      await expect(
        payload.findGlobalVersions({
          slug: slug as never,
          overrideAccess: false,
          req: anonymousReq,
        }),
      ).rejects.toMatchObject({ status: 403 })
    }
    await expect(
      payload.findVersions({
        collection: 'time-entries',
        overrideAccess: false,
        req: anonymousReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.findVersions({
        collection: 'time-entries',
        overrideAccess: false,
        req: userReq,
      }),
    ).resolves.toMatchObject({ totalDocs: expect.any(Number) })
  })

  it('requires eight characters on user creation and password changes', async () => {
    await expect(
      createDocument(
        'users',
        {
          displayName: 'Short Password User',
          email: 'short-password@example.test',
          password: 'short7!',
          timezone: 'Pacific/Auckland',
        },
        { overrideAccess: false, req: userReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      updateDocument(
        'users',
        user.id,
        { password: 'short7!' },
        { overrideAccess: false, req: userReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    const minimumPasswordUser = await createDocument<TestUser>(
      'users',
      {
        displayName: 'Minimum Password User',
        email: 'minimum-password@example.test',
        password: 'eight888',
        timezone: 'Pacific/Auckland',
      },
      { overrideAccess: false, req: userReq },
    )
    expect(minimumPasswordUser).toMatchObject({ email: 'minimum-password@example.test' })
    await deleteDocument('users', minimumPasswordUser.id, { overrideAccess: false, req: userReq })
  })

  it('revokes sessions when the password is changed or reset', async () => {
    const changedPassword = 'changed-password-456!'
    const directResetPassword = 'direct-reset-password-567!'
    const resetPassword = 'reset-password-789!'
    const jwtHeaders = (token: string) => new Headers({ Authorization: `JWT ${token}` })
    const storedUser = async () =>
      payload.findByID({
        collection: 'users',
        id: user.id,
        overrideAccess: true,
        showHiddenFields: true,
      })

    const earlierLogin = await payload.login({
      collection: 'users',
      data: { email: USER_EMAIL, password: PASSWORD },
    })
    if (!earlierLogin.token) throw new Error('Payload did not return a session token.')
    await expect(payload.auth({ headers: jwtHeaders(earlierLogin.token) })).resolves.toMatchObject({
      user: { id: user.id },
    })

    await expect(
      changeOwnPassword(await sessionFor(user), 'wrong-password-000!', changedPassword),
    ).rejects.toMatchObject({ code: 'password-change-failed' })
    await expect(
      changeOwnPassword(await sessionFor(user), PASSWORD, PASSWORD),
    ).rejects.toMatchObject({ code: 'password-unchanged' })
    await expect(
      changeOwnPassword(await sessionFor(user), PASSWORD, 'short7!'),
    ).rejects.toMatchObject({ code: 'invalid-password' })

    const replacementToken = await changeOwnPassword(
      await sessionFor(user),
      PASSWORD,
      changedPassword,
    )
    expect(replacementToken.length).toBeGreaterThan(20)
    expect((await storedUser()).sessions).toHaveLength(1)
    await expect(payload.auth({ headers: jwtHeaders(earlierLogin.token) })).resolves.toMatchObject({
      user: null,
    })
    await expect(payload.auth({ headers: jwtHeaders(replacementToken) })).resolves.toMatchObject({
      user: { id: user.id },
    })
    await expect(
      payload.login({
        collection: 'users',
        data: { email: USER_EMAIL, password: PASSWORD },
      }),
    ).rejects.toBeDefined()

    // A direct password update through the collection also ends every session.
    await updateDocument(
      'users',
      user.id,
      { password: PASSWORD },
      { overrideAccess: false, req: userReq },
    )
    expect((await storedUser()).sessions).toEqual([])
    await expect(payload.auth({ headers: jwtHeaders(replacementToken) })).resolves.toMatchObject({
      user: null,
    })

    // No email delivery is configured, so a reset that would send email is refused.
    await expect(
      payload.forgotPassword({
        collection: 'users',
        data: { email: USER_EMAIL },
        overrideAccess: true,
      }),
    ).rejects.toBeDefined()

    const sessionBeforeReset = await payload.login({
      collection: 'users',
      data: { email: USER_EMAIL, password: PASSWORD },
    })
    const directResetToken = await payload.forgotPassword({
      collection: 'users',
      data: { email: USER_EMAIL },
      disableEmail: true,
      overrideAccess: true,
    })
    expect(directResetToken).toBeTypeOf('string')
    await payload.resetPassword({
      collection: 'users',
      data: { password: directResetPassword, token: directResetToken ?? '' },
      overrideAccess: true,
    })
    const directlyResetUser = await storedUser()
    expect(directlyResetUser.sessions).toHaveLength(1)
    expect(directlyResetUser).toMatchObject({
      resetPasswordExpiration: null,
      resetPasswordToken: null,
    })
    await expect(
      payload.auth({ headers: jwtHeaders(sessionBeforeReset.token ?? '') }),
    ).resolves.toMatchObject({ user: null })

    await expect(
      completePasswordReset(payload, 'not-a-valid-token', resetPassword),
    ).rejects.toMatchObject({ code: 'invalid-password-reset' })
    const forgotToken = await payload.forgotPassword({
      collection: 'users',
      data: { email: USER_EMAIL },
      disableEmail: true,
      overrideAccess: true,
    })
    const resetSessionToken = await completePasswordReset(payload, forgotToken ?? '', resetPassword)
    expect(resetSessionToken.length).toBeGreaterThan(20)
    expect((await storedUser()).sessions).toHaveLength(1)
    await expect(payload.auth({ headers: jwtHeaders(resetSessionToken) })).resolves.toMatchObject({
      user: { id: user.id },
    })
    await expect(
      payload.login({
        collection: 'users',
        data: { email: USER_EMAIL, password: directResetPassword },
      }),
    ).rejects.toBeDefined()

    // Restore the shared password for the remaining tests.
    await changeOwnPassword(await sessionFor(user), resetPassword, PASSWORD)
  })

  it('pins an explicitly selected Xero tenant, serializes refresh, and disconnects safely', async () => {
    const session = { payload, req: userReq, user } as unknown as AppSession
    await expect(getAccountingConnectionView(session)).resolves.toMatchObject({
      callbackURI: 'http://localhost:3000/api/integrations/xero/accounting/callback',
      configured: false,
      status: 'not-configured',
    })
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
        req: userReq,
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
    const listConnections = vi.fn(async (_accessToken: string, authEventID?: string) =>
      authEventID === authenticationEventId ? [] : connections,
    )
    const client: XeroAccountingClient = {
      accountingGet: vi.fn(async (_accessToken, tenantID, path) => {
        if (path === 'Organisation') {
          return {
            data: {
              Organisations: [
                {
                  Name: 'Pinned Demo Company',
                  OrganisationID: tenantID,
                },
              ],
            },
          }
        }
        if (path === 'Organisation/Actions') {
          return {
            data: {
              Actions: [{ Name: 'CreateDraftInvoice', Status: 'ALLOWED' }],
            },
          }
        }
        return { data: {} }
      }),
      accountingPost: vi.fn(async () => ({ data: {} })),
      deleteConnection,
      exchangeCode: vi.fn(async () => initialTokenSet),
      listConnections,
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
    expect(listConnections).toHaveBeenNthCalledWith(
      1,
      initialTokenSet.accessToken,
      authenticationEventId,
    )
    expect(listConnections).toHaveBeenNthCalledWith(2, initialTokenSet.accessToken)

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
      req: userReq,
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
      { client, config: accountingConfig },
    )
    expect(client.accountingGet).toHaveBeenCalledWith(
      initialTokenSet.accessToken,
      selectedConnection.tenantId,
      'Organisation',
    )
    expect(client.accountingGet).toHaveBeenCalledWith(
      initialTokenSet.accessToken,
      selectedConnection.tenantId,
      'Organisation/Actions',
    )

    const privateConnections = await payload.find({
      collection: 'xero-connections',
      depth: 0,
      overrideAccess: true,
      req: userReq,
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
        req: userReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.find({
        collection: 'xero-oauth-states',
        overrideAccess: false,
        req: userReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.create({
        collection: 'xero-connections',
        data: { singletonKey: 'user-created', status: 'disconnected', tokenVersion: 0 },
        overrideAccess: false,
        req: userReq,
      }),
    ).rejects.toMatchObject({ status: 403 })

    await payload.update({
      collection: 'xero-connections',
      id: connection.id,
      data: { accessTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() },
      overrideAccess: true,
      req: userReq,
    })
    // Concurrent HTTP requests never share a mutable Payload request object.
    // Use independent requests here while exercising the shared database lock.
    const firstRefreshSession = await sessionFor(user)
    const secondRefreshSession = await sessionFor(user)
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
      disconnectAccountingConnection(session, undefined, {
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
      req: userReq,
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

    // Reconnecting works as any Xero user who can reach the pinned organisation: the person who
    // connected it originally may have left. A different organisation is still refused.
    const replacementXeroUserId = '77777777-7777-4777-8777-777777777777'
    const replacementValidate = vi.fn(async () => ({
      authenticationEventId,
      scopes: [...REQUIRED_ACCOUNTING_SCOPES],
      xeroUserId: replacementXeroUserId,
    }))
    const reconnectWith = async (tenants: typeof connections) => {
      const reconnect = await createAccountingAuthorization(session, { config: accountingConfig })
      listConnections.mockImplementation(async () => tenants)
      return completeAccountingCallback(
        session,
        {
          browserBinding: reconnect.browserBinding,
          code: `reconnect-${tenants.length}`,
          state: new URL(reconnect.authorizationURL).searchParams.get('state') ?? '',
        },
        { client, config: accountingConfig, validateAccessToken: replacementValidate },
      )
    }
    await expect(
      reconnectWith([connections[0] as (typeof connections)[number]]),
    ).rejects.toMatchObject({ code: 'wrong-tenant' })
    await expect(reconnectWith(connections)).resolves.toEqual({ status: 'connected' })
    const reconnected = await payload.findByID({
      collection: 'xero-connections',
      id: connection.id,
      overrideAccess: true,
      req: userReq,
      showHiddenFields: true,
    })
    expect(reconnected).toMatchObject({
      authorizingXeroUserId: replacementXeroUserId,
      status: 'connected',
      tenantId: selectedConnection.tenantId,
    })
  })

  it('lets the user update their profile without changing existing entry snapshots', async () => {
    const updated = await updateDocument<TestUser>(
      'users',
      user.id,
      {
        displayName: '  Updated Integration User  ',
        timezone: 'Australia/Sydney',
      },
      { overrideAccess: false, req: userReq },
    )
    const existingEntry = await findDocument<TestTimeEntry>('time-entries', reservedEntry.id, {
      overrideAccess: true,
    })

    expect(updated).toMatchObject({
      displayName: 'Updated Integration User',
      email: USER_EMAIL,
      timezone: 'Australia/Sydney',
    })
    expect(existingEntry.timezone).toBe('Pacific/Auckland')

    await expect(
      updateDocument(
        'users',
        user.id,
        { timezone: 'Not/A_Timezone' },
        { overrideAccess: false, req: userReq },
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      updateDocument(
        'users',
        user.id,
        { displayName: 'Changed anonymously' },
        { overrideAccess: false, req: anonymousReq },
      ),
    ).rejects.toMatchObject({ status: 403 })

    await updateDocument(
      'users',
      user.id,
      { displayName: user.displayName, timezone: user.timezone },
      { overrideAccess: false, req: userReq },
    )
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
        { overrideAccess: false, req: userReq },
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
        { overrideAccess: false, req: userReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      updateDocument(
        'customers',
        customer.id,
        { currency: 'USD' },
        { overrideAccess: false, req: userReq },
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

  it('defaults entry ownership to the signed-in user and derives billing snapshots', () => {
    expect(reservedEntry).toMatchObject({
      billingStatus: 'unbilled',
      currencySnapshot: 'NZD',
      customerNameSnapshot: 'Primary Customer',
      durationSeconds: 5_400,
      projectCodeSnapshot: 'NZ-CORE',
      projectNameSnapshot: 'Core Integration Project',
      rateSnapshotScaled: 1_250_000,
    })
    expect(relationshipID(reservedEntry.owner)).toBe(user.id)
    expect(relationshipID(reservedEntry.customer)).toBe(customer.id)
  })

  it('keeps an existing rate snapshot when an unchanged project is resubmitted', async () => {
    await updateDocument(
      'projects',
      project.id,
      {
        confirmUnbilledImpact: true,
        hourlyRateScaled: 2_000_000,
      },
      { overrideAccess: false, req: userReq },
    )

    await updateDocument<TestTimeEntry>(
      'time-entries',
      unbilledEntry.id,
      {
        description: 'Description changed after the project rate',
        project: project.id,
      },
      { overrideAccess: false, req: userReq },
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
      { overrideAccess: false, req: userReq },
    )
    postRateEntry = createdEntry
    const existingEntry = await findDocument<TestTimeEntry>('time-entries', unbilledEntry.id, {
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
        confirmUnbilledImpact: true,
        hourlyRateScaled: 1_250_000,
      },
      { overrideAccess: false, req: userReq },
    )
  })

  it('recalculates only changed unbilled rate snapshots with preview and audit', async () => {
    await updateDocument(
      'projects',
      project.id,
      {
        confirmUnbilledImpact: true,
        hourlyRateScaled: 1_500_000,
      },
      { overrideAccess: false, req: userReq },
    )
    const session = await sessionFor(user)
    const preview = await previewProjectRateRecalculation(session, String(project.id))
    expect(preview).toMatchObject({ affectedCount: 2, currentRateScaled: 1_500_000 })
    await expect(
      confirmProjectRateRecalculation(session, {
        confirmation: 'RECALCULATE',
        expectedHash: 'stale-preview-hash',
        projectID: String(project.id),
        reason: 'Apply the approved project rate to unbilled integration entries.',
      }),
    ).rejects.toThrow('changed')
    await expect(
      confirmProjectRateRecalculation(session, {
        confirmation: 'RECALCULATE',
        expectedHash: preview.hash,
        projectID: String(project.id),
        reason: '',
      }),
    ).resolves.toBe(2)

    const reserved = await findDocument<TestTimeEntry>('time-entries', reservedEntry.id, {
      overrideAccess: true,
    })
    const recalculated = await Promise.all([
      findDocument<TestTimeEntry>('time-entries', unbilledEntry.id, { overrideAccess: true }),
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
        confirmUnbilledImpact: true,
        hourlyRateScaled: 1_250_000,
      },
      { overrideAccess: false, req: userReq },
    )
  })

  it('lets the user correct and delete unbilled time without touching system snapshots', async () => {
    const corrected = await updateDocument<TestTimeEntry>(
      'time-entries',
      unbilledEntry.id,
      {
        description: '  Corrected integration entry  ',
        durationSeconds: 60,
        rateSnapshotScaled: 1,
      },
      { overrideAccess: false, req: userReq },
    )
    expect(corrected).toMatchObject({
      description: 'Corrected integration entry',
      durationSeconds: 2_700,
      rateSnapshotScaled: 1_500_000,
    })

    await deleteDocument('time-entries', unbilledEntry.id, { overrideAccess: false, req: userReq })
    await expect(
      payload.findByID({
        collection: 'time-entries',
        id: unbilledEntry.id,
        overrideAccess: true,
      }),
    ).rejects.toMatchObject({ status: 404 })
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
      { overrideAccess: false, req: userReq },
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
        { overrideAccess: false, req: userReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      createDocument(
        'time-entries',
        { ...durationInput, enteredHours: 24, enteredMinutes: 1 },
        { overrideAccess: false, req: userReq },
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
        { overrideAccess: false, req: userReq },
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('prevents generic update or deletion after an entry is reserved', async () => {
    await expect(
      updateDocument(
        'time-entries',
        reservedEntry.id,
        { description: 'Tried to change locked time' },
        { overrideAccess: false, req: userReq },
      ),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      deleteDocument('time-entries', reservedEntry.id, {
        overrideAccess: false,
        req: userReq,
      }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      updateDocument(
        'time-entries',
        reservedEntry.id,
        { description: 'overrideAccess alone cannot bypass the billing lock' },
        { overrideAccess: true },
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      deleteDocument('time-entries', reservedEntry.id, {
        overrideAccess: true,
        req: trustedBillingReq,
      }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      updateDocument(
        'time-entries',
        reservedEntry.id,
        {
          billingStatus: 'unbilled',
          description: 'A billing context must not change ordinary entry data',
          exportedAt: null,
          reservedAt: null,
        },
        { overrideAccess: true, req: trustedReleaseReq },
      ),
    ).rejects.toMatchObject({ status: 400 })

    const lockedEntry = await findDocument<TestTimeEntry>('time-entries', reservedEntry.id, {
      overrideAccess: true,
    })
    expect(lockedEntry.billingStatus).toBe('reserved')

    await expect(
      updateDocument(
        'time-entries',
        reservedEntry.id,
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

  it('lets the signed-in user update both settings globals', async () => {
    await expect(
      updateGlobal('business-settings', { businessName: 'Integration Business' }, userReq),
    ).resolves.toMatchObject({ businessName: 'Integration Business' })
    await expect(findGlobal('business-settings', userReq)).resolves.toMatchObject({
      businessName: 'Integration Business',
    })
    await expect(
      updateGlobal('billing-settings', { invoiceReferencePrefix: ' TEST- ' }, userReq),
    ).resolves.toMatchObject({ invoiceReferencePrefix: 'TEST-' })
    await expect(
      updateGlobal('billing-settings', { invoiceReferencePrefix: 'ANON-' }, anonymousReq),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      payload.findGlobalVersions({
        slug: 'billing-settings',
        overrideAccess: false,
        req: userReq,
      }),
    ).resolves.toMatchObject({ totalDocs: expect.any(Number) })
  })

  it('rejects new time when the project customer is archived', async () => {
    await updateDocument<TestCustomer>(
      'customers',
      customer.id,
      { status: 'archived' },
      { overrideAccess: false, req: userReq },
    )

    await expect(
      updateDocument(
        'projects',
        project.id,
        { description: 'The project remains editable after its customer is archived.' },
        { overrideAccess: false, req: userReq },
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
        { overrideAccess: false, req: userReq },
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
      { user: { ...user, collection: 'users' } as never },
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
        { user: { ...user, collection: 'users' } as never },
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
