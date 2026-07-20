// @vitest-environment node

import { createLocalReq, getPayload, registerFirstUserOperation, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppSession } from '@/lib/member-app/session'
import {
  REQUIRED_ACCOUNTING_SCOPES,
  type XeroAccountingRuntimeConfig,
  type XeroConnectionCandidate,
} from '@/lib/xero/accounting/contracts'
import {
  completeAccountingCallback,
  createAccountingAuthorization,
  selectAccountingTenant,
} from '@/lib/xero/accounting/service'
import type { AccountingAccessTokenMetadata } from '@/lib/xero/accounting/token'
import config from '@/payload.config'

const PASSWORD = 'capability-integration-password-123!'
const AUTH_EVENT_ID = '11111111-1111-4111-8111-111111111111'
const XERO_USER_ID = '22222222-2222-4222-8222-222222222222'
const accountingConfig = {
  clientID: 'capability-accounting-client',
  clientSecret: 'capability-accounting-secret',
  configured: true,
  redirectURI: 'http://localhost:3000/api/integrations/xero/accounting/callback',
  tokenEncryptionKey: '55'.repeat(32),
  tokenEncryptionKeyVersion: 1,
} as const

const candidate = (sequence: number): XeroConnectionCandidate => ({
  authEventId: AUTH_EVENT_ID,
  connectionId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  tenantId: `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
  tenantName: `Capability Company ${sequence}`,
  tenantType: 'ORGANISATION',
})

const provider = (candidates: XeroConnectionCandidate[], actions: string[] = []) => {
  const tokenSet = {
    accessToken: 'capability-access-token',
    expiresIn: 1_800,
    refreshToken: 'capability-refresh-token',
    scopes: [...REQUIRED_ACCOUNTING_SCOPES],
  }
  return {
    client: {
      accountingGet: vi.fn(async (_accessToken, tenantID, path) => ({
        data:
          path === 'Organisation'
            ? {
                Organisations: [
                  {
                    Name: candidates.find((item) => item.tenantId === tenantID)?.tenantName,
                    OrganisationActions: actions,
                    OrganisationID: tenantID,
                  },
                ],
              }
            : {},
      })),
      accountingPost: vi.fn(async () => ({ data: {} })),
      deleteConnection: vi.fn(async () => undefined),
      exchangeCode: vi.fn(async () => tokenSet),
      listConnections: vi.fn(async () => candidates),
      refreshTokens: vi.fn(async () => tokenSet),
      revokeRefreshToken: vi.fn(async () => undefined),
    },
    validateAccessToken: vi.fn(
      async (
        _accessToken: string,
        _config: XeroAccountingRuntimeConfig,
      ): Promise<AccountingAccessTokenMetadata> => ({
        authenticationEventId: AUTH_EVENT_ID,
        scopes: [...REQUIRED_ACCOUNTING_SCOPES],
        xeroUserId: XERO_USER_ID,
      }),
    ),
  }
}

let payload: Payload
let session: AppSession

const clearConnectionState = async (): Promise<void> => {
  for (const slug of [
    'audit-events',
    'xero-reference-data',
    'xero-oauth-states',
    'xero-connections',
  ]) {
    await payload.db.collections[slug]?.deleteMany({})
    await payload.db.versions[slug]?.deleteMany({})
  }
}

const callbackInput = (
  authorization: Awaited<ReturnType<typeof createAccountingAuthorization>>,
) => ({
  browserBinding: authorization.browserBinding,
  code: 'capability-code',
  state: new URL(authorization.authorizationURL).searchParams.get('state') ?? '',
})

const expectNoConnection = async (): Promise<void> => {
  const connections = await payload.find({
    collection: 'xero-connections',
    depth: 0,
    overrideAccess: true,
    req: session.req,
  })
  expect(connections.docs).toHaveLength(0)
}

describe.sequential('Xero accounting capability validation', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    await clearConnectionState()
    await payload.db.collections.users?.deleteMany({})
    await payload.db.versions.users?.deleteMany({})

    const anonymousReq = await createLocalReq({}, payload)
    const bootstrap = await registerFirstUserOperation({
      collection: payload.collections.users,
      data: {
        active: true,
        displayName: 'Capability Owner',
        email: 'capability-owner@example.test',
        password: PASSWORD,
        role: 'owner',
        timezone: 'Pacific/Auckland',
      } as never,
      req: anonymousReq,
    })
    if (!bootstrap.user) throw new Error('Owner bootstrap failed.')
    session = {
      payload,
      req: await createLocalReq({ user: bootstrap.user }, payload),
      user: bootstrap.user,
    }
  }, 60_000)

  beforeEach(async () => {
    await clearConnectionState()
  })

  afterAll(async () => {
    if (!payload) return
    await clearConnectionState()
    await payload.db.collections.users?.deleteMany({})
    await payload.db.versions.users?.deleteMany({})
    await payload.destroy()
  })

  it('rejects an incapable single organisation before persisting its grant', async () => {
    const incapable = provider([candidate(1)])
    const authorization = await createAccountingAuthorization(session, {
      config: accountingConfig,
    })

    await expect(
      completeAccountingCallback(session, callbackInput(authorization), {
        client: incapable.client,
        config: accountingConfig,
        validateAccessToken: incapable.validateAccessToken,
      }),
    ).rejects.toMatchObject({ code: 'missing-create-draft-capability' })

    expect(incapable.client.accountingGet).toHaveBeenCalledWith(
      'capability-access-token',
      candidate(1).tenantId,
      'Organisation',
    )
    await expectNoConnection()
  })

  it('rejects an incapable explicit tenant selection before persisting its grant', async () => {
    const candidates = [candidate(1), candidate(2)]
    const incapable = provider(candidates)
    const authorization = await createAccountingAuthorization(session, {
      config: accountingConfig,
    })
    const callback = await completeAccountingCallback(session, callbackInput(authorization), {
      client: incapable.client,
      config: accountingConfig,
      validateAccessToken: incapable.validateAccessToken,
    })
    expect(callback).toMatchObject({ status: 'select-tenant' })

    await expect(
      selectAccountingTenant(
        session,
        {
          browserBinding: authorization.browserBinding,
          flowID: callback.flowID ?? '',
          tenantID: candidates[1]!.tenantId,
        },
        { client: incapable.client, config: accountingConfig },
      ),
    ).rejects.toMatchObject({ code: 'missing-create-draft-capability' })

    expect(incapable.client.accountingGet).toHaveBeenCalledWith(
      'capability-access-token',
      candidates[1]!.tenantId,
      'Organisation',
    )
    await expectNoConnection()
  })
})
