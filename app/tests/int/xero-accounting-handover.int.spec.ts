// @vitest-environment node

import { createLocalReq, getPayload, registerFirstUserOperation, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AppSession } from '@/lib/member-app/session'
import type { XeroAccountingClient } from '@/lib/xero/accounting/client'
import {
  REQUIRED_ACCOUNTING_SCOPES,
  type XeroConnectionCandidate,
  type XeroTokenSet,
} from '@/lib/xero/accounting/contracts'
import {
  completeAccountingCallback,
  createAccountingAuthorization,
  createAccountingHandoverAuthorization,
} from '@/lib/xero/accounting/service'
import type { AccountingAccessTokenMetadata } from '@/lib/xero/accounting/token'
import type { XeroConnection } from '@/payload-types'
import config from '@/payload.config'

const PASSWORD = 'handover-integration-password-123!'
const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'
const accountingConfig = {
  clientID: 'handover-accounting-client',
  clientSecret: 'handover-accounting-secret',
  configured: true,
  redirectURI: 'http://localhost:3000/api/integrations/xero/accounting/callback',
  tokenEncryptionKey: '44'.repeat(32),
  tokenEncryptionKeyVersion: 1,
} as const

type Provider = {
  client: XeroAccountingClient
  revokeRefreshToken: ReturnType<typeof vi.fn>
  validateAccessToken: (accessToken: string) => Promise<AccountingAccessTokenMetadata>
}

let payload: Payload
let session: AppSession
let initialConnection: XeroConnection

const clear = async (): Promise<void> => {
  for (const slug of [
    'payload-jobs',
    'audit-events',
    'xero-attempts',
    'invoice-export-entries',
    'invoice-exports',
    'export-batches',
    'xero-oauth-states',
    'xero-connections',
    'external-auth-sessions',
    'auth-identities',
    'users',
  ]) {
    await payload.db.collections[slug]?.deleteMany({})
    await payload.db.versions[slug]?.deleteMany({})
  }
  await payload.db.connection.db?.collection('application_bootstrap_locks').deleteMany({})
}

const candidate = (
  tenantId = TENANT_ID,
  authenticationEventId = '33333333-3333-4333-8333-333333333333',
): XeroConnectionCandidate => ({
  authEventId: authenticationEventId,
  connectionId: CONNECTION_ID,
  tenantId,
  tenantName: tenantId === TENANT_ID ? 'Pinned Demo Company' : 'Wrong Demo Company',
  tenantType: 'ORGANISATION',
})

const provider = (input: {
  accessToken: string
  actions?: Array<{ Name: string; Status: string }>
  candidates?: XeroConnectionCandidate[]
  refreshToken: string
  xeroUserId: string
}): Provider => {
  const authenticationEventId =
    input.candidates?.[0]?.authEventId ?? '33333333-3333-4333-8333-333333333333'
  const tokenSet: XeroTokenSet = {
    accessToken: input.accessToken,
    expiresIn: 1_800,
    refreshToken: input.refreshToken,
    scopes: [...REQUIRED_ACCOUNTING_SCOPES],
  }
  const revokeRefreshToken = vi.fn(async () => undefined)
  return {
    client: {
      accountingGet: vi.fn(async (_token, tenantID, path) => {
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
              Actions: input.actions ?? [{ Name: 'CreateDraftInvoice', Status: 'ALLOWED' }],
            },
          }
        }
        return { data: {} }
      }),
      accountingPost: vi.fn(async () => ({ data: {} })),
      deleteConnection: vi.fn(async () => undefined),
      exchangeCode: vi.fn(async () => tokenSet),
      listConnections: vi.fn(async () => input.candidates ?? [candidate()]),
      refreshTokens: vi.fn(async () => tokenSet),
      revokeRefreshToken,
    },
    revokeRefreshToken,
    validateAccessToken: vi.fn(async () => ({
      authenticationEventId,
      scopes: [...REQUIRED_ACCOUNTING_SCOPES],
      xeroUserId: input.xeroUserId,
    })),
  }
}

const callbackInput = (
  authorization: Awaited<ReturnType<typeof createAccountingAuthorization>>,
  code: string,
) => ({
  browserBinding: authorization.browserBinding,
  code,
  state: new URL(authorization.authorizationURL).searchParams.get('state') ?? '',
})

const readConnection = async (): Promise<XeroConnection> => {
  const result = await payload.find({
    collection: 'xero-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
  const connection = result.docs[0]
  if (!connection) throw new Error('The accounting connection is missing.')
  return connection
}

describe.sequential('Xero accounting authorizer handover', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    await clear()
    const anonymousReq = await createLocalReq({}, payload)
    const bootstrap = await registerFirstUserOperation({
      collection: payload.collections.users,
      data: {
        active: true,
        displayName: 'Handover Owner',
        email: 'handover-owner@example.test',
        password: PASSWORD,
        role: 'owner',
        timezone: 'Pacific/Auckland',
      } as never,
      req: anonymousReq,
    })
    if (!bootstrap.user) throw new Error('Owner bootstrap failed.')
    const req = await createLocalReq({ user: bootstrap.user }, payload)
    session = { payload, req, user: bootstrap.user }

    const initialProvider = provider({
      accessToken: 'initial-access-token',
      refreshToken: 'initial-refresh-token',
      xeroUserId: '44444444-4444-4444-8444-444444444444',
    })
    const authorization = await createAccountingAuthorization(session, {
      config: accountingConfig,
    })
    await completeAccountingCallback(session, callbackInput(authorization, 'initial-code'), {
      client: initialProvider.client,
      config: accountingConfig,
      validateAccessToken: initialProvider.validateAccessToken,
    })
    initialConnection = await readConnection()
  }, 60_000)

  afterAll(async () => {
    if (!payload) return
    await clear()
    await payload.destroy()
  })

  it('retains the working credential when a handover authorizes the wrong tenant', async () => {
    const authorization = await createAccountingHandoverAuthorization(
      session,
      'Move accounting authority to the replacement finance operator.',
      { config: accountingConfig },
    )
    const wrongTenant = provider({
      accessToken: 'wrong-tenant-access-token',
      candidates: [candidate('99999999-9999-4999-8999-999999999999')],
      refreshToken: 'wrong-tenant-refresh-token',
      xeroUserId: '55555555-5555-4555-8555-555555555555',
    })
    const wrongTenantCandidates = vi.mocked(wrongTenant.client.listConnections)
    wrongTenantCandidates.mockImplementation(async (_accessToken, authEventID) =>
      authEventID ? [] : [candidate('99999999-9999-4999-8999-999999999999')],
    )

    await expect(
      completeAccountingCallback(session, callbackInput(authorization, 'wrong-tenant-code'), {
        client: wrongTenant.client,
        config: accountingConfig,
        validateAccessToken: wrongTenant.validateAccessToken,
      }),
    ).rejects.toMatchObject({ code: 'wrong-tenant' })
    const unchanged = await readConnection()
    expect(unchanged).toMatchObject({
      accessTokenEnvelope: initialConnection.accessTokenEnvelope,
      authorizingXeroUserId: initialConnection.authorizingXeroUserId,
      refreshTokenEnvelope: initialConnection.refreshTokenEnvelope,
      tenantId: TENANT_ID,
      tokenVersion: initialConnection.tokenVersion,
    })
    expect(wrongTenantCandidates).toHaveBeenCalledTimes(2)
    expect(wrongTenant.revokeRefreshToken).not.toHaveBeenCalled()
  })

  it('retains the working credential when draft-invoice capability validation fails', async () => {
    const authorization = await createAccountingHandoverAuthorization(
      session,
      'Validate the replacement finance operator before any cutover occurs.',
      { config: accountingConfig },
    )
    const incapable = provider({
      accessToken: 'incapable-access-token',
      actions: [],
      refreshToken: 'incapable-refresh-token',
      xeroUserId: '55555555-5555-4555-8555-555555555555',
    })

    await expect(
      completeAccountingCallback(session, callbackInput(authorization, 'incapable-code'), {
        client: incapable.client,
        config: accountingConfig,
        validateAccessToken: incapable.validateAccessToken,
      }),
    ).rejects.toMatchObject({ code: 'missing-create-draft-capability' })
    const unchanged = await readConnection()
    expect(unchanged).toMatchObject({
      accessTokenEnvelope: initialConnection.accessTokenEnvelope,
      authorizingXeroUserId: initialConnection.authorizingXeroUserId,
      refreshTokenEnvelope: initialConnection.refreshTokenEnvelope,
      tokenVersion: initialConnection.tokenVersion,
    })
    expect(incapable.client.accountingGet).toHaveBeenCalledWith(
      'incapable-access-token',
      TENANT_ID,
      'Organisation/Actions',
    )
    expect(incapable.revokeRefreshToken).not.toHaveBeenCalled()
  })

  it('atomically accepts one callback, preserves the tenant, audits lineage, and revokes the old grant', async () => {
    const authorization = await createAccountingHandoverAuthorization(
      session,
      'Complete the approved accounting authorizer handover.',
      { config: accountingConfig },
    )
    const replacement = provider({
      accessToken: 'replacement-access-token',
      refreshToken: 'replacement-refresh-token',
      xeroUserId: '55555555-5555-4555-8555-555555555555',
    })
    const input = callbackInput(authorization, 'replacement-code')
    const callbacks = await Promise.allSettled([
      completeAccountingCallback(session, input, {
        client: replacement.client,
        config: accountingConfig,
        validateAccessToken: replacement.validateAccessToken,
      }),
      completeAccountingCallback(session, input, {
        client: replacement.client,
        config: accountingConfig,
        validateAccessToken: replacement.validateAccessToken,
      }),
    ])
    expect(callbacks.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(callbacks.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const updated = await readConnection()
    expect(updated).toMatchObject({
      authorizingXeroUserId: '55555555-5555-4555-8555-555555555555',
      connectionId: CONNECTION_ID,
      status: 'connected',
      tenantId: TENANT_ID,
      tokenVersion: (initialConnection.tokenVersion ?? 0) + 1,
    })
    expect(updated.accessTokenEnvelope).not.toBe(initialConnection.accessTokenEnvelope)
    expect(updated.refreshTokenEnvelope).not.toBe(initialConnection.refreshTokenEnvelope)
    expect(replacement.revokeRefreshToken).toHaveBeenCalledWith('initial-refresh-token')

    const audits = await payload.find({
      collection: 'audit-events',
      depth: 0,
      overrideAccess: true,
      req: session.req,
      where: { eventType: { equals: 'xero.accounting-handover' } },
    })
    expect(audits.docs).toHaveLength(1)
    expect(audits.docs[0]?.metadata).toMatchObject({
      authorizingXeroUserId: '55555555-5555-4555-8555-555555555555',
      credentialLineageVersion: updated.tokenVersion,
      previousAuthorizingXeroUserId: '44444444-4444-4444-8444-444444444444',
      previousCredentialLineageVersion: initialConnection.tokenVersion,
      tenantId: TENANT_ID,
    })
  })

  it('reconnects only the pinned tenant and revokes the obsolete same-authorizer grant', async () => {
    const current = await readConnection()
    await payload.update({
      collection: 'xero-connections',
      id: current.id,
      data: { status: 'action-required' },
      overrideAccess: true,
      req: session.req,
    })
    const authorization = await createAccountingAuthorization(session, {
      config: accountingConfig,
    })
    const reconnect = provider({
      accessToken: 'reconnect-access-token',
      refreshToken: 'reconnect-refresh-token',
      xeroUserId: current.authorizingXeroUserId ?? '',
    })
    await expect(
      completeAccountingCallback(session, callbackInput(authorization, 'reconnect-code'), {
        client: reconnect.client,
        config: accountingConfig,
        validateAccessToken: reconnect.validateAccessToken,
      }),
    ).resolves.toEqual({ status: 'connected' })
    const reconnected = await readConnection()
    expect(reconnected).toMatchObject({
      authorizingXeroUserId: current.authorizingXeroUserId,
      connectionId: CONNECTION_ID,
      status: 'connected',
      tenantId: TENANT_ID,
      tokenVersion: (current.tokenVersion ?? 0) + 1,
    })
    expect(reconnect.revokeRefreshToken).toHaveBeenCalledWith('replacement-refresh-token')
  })
})
