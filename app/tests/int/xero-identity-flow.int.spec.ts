// @vitest-environment node

import {
  createLocalReq,
  getPayload,
  registerFirstUserOperation,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { issueInvitation } from '@/lib/account-lifecycle/service'
import type { AppSession } from '@/lib/member-app/session'
import type { XeroIdentityClient } from '@/lib/xero/identity/client'
import { XERO_IDENTITY_ISSUER, type XeroIdentityClaims } from '@/lib/xero/identity/contracts'
import {
  completeIdentityCallback,
  createIdentityAuthorization,
  recoverExternalIdentityForUser,
  unlinkIdentity,
} from '@/lib/xero/identity/service'
import config from '@/payload.config'

const PASSWORD = 'identity-integration-password!'
const identityConfig = {
  authFlowEncryptionKey: '33'.repeat(32),
  authFlowEncryptionKeyVersion: 1,
  clientID: 'identity-integration-client',
  clientSecret: 'identity-integration-secret',
  configured: true,
  redirectURI: 'http://localhost:3000/api/auth/xero/identity/callback',
} as const

let payload: Payload
let ownerSession: AppSession
let memberSession: AppSession
let invitationToken = ''
let memberID = ''
let originalIdentityID = ''
let flowSequence = 0
let claims: XeroIdentityClaims = {
  displayName: 'Invited Identity User',
  email: 'identity-invite@example.test',
  issuer: XERO_IDENTITY_ISSUER,
  subject: 'identity-subject-001',
}

const authorizationInputs: Array<{ nonce: string; pkceChallenge: string; state: string }> = []
const callbackInputs: Array<{
  expectedNonce: string
  expectedState: string
  pkceVerifier: string
}> = []

const client: XeroIdentityClient = {
  authorizationURL: vi.fn(async (input) => {
    authorizationInputs.push(input)
    const url = new URL('https://login.xero.com/identity/connect/authorize')
    url.searchParams.set('scope', 'openid profile email')
    url.searchParams.set('state', input.state)
    return url.toString()
  }),
  exchangeCallback: vi.fn(async (input) => {
    callbackInputs.push({
      expectedNonce: input.expectedNonce,
      expectedState: input.expectedState,
      pkceVerifier: input.pkceVerifier,
    })
    return claims
  }),
}

const createFlowValues = async () => {
  flowSequence += 1
  const suffix = String(flowSequence).padStart(3, '0')
  return {
    nonce: `nonce-${suffix}-${'n'.repeat(48)}`,
    pkceChallenge: `challenge-${suffix}-${'c'.repeat(48)}`,
    pkceVerifier: `verifier-${suffix}-${'v'.repeat(48)}`,
    state: `state-${suffix}-${'s'.repeat(48)}`,
  }
}

const requestFor = (user: AppSession['user']): Promise<PayloadRequest> =>
  createLocalReq({ user }, payload)

const clear = async () => {
  for (const slug of [
    'audit-events',
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

const startFlow = async (
  purpose: 'identity-link' | 'invite-acceptance' | 'sign-in',
  input: { invitationToken?: string; recentlyReauthenticated?: boolean; session?: AppSession } = {},
) => {
  const authorization = await createIdentityAuthorization(
    payload,
    {
      invitationToken: input.invitationToken,
      purpose,
      recentlyReauthenticated: input.recentlyReauthenticated,
      returnPath: '/app/profile',
      session: input.session,
    },
    { client, config: identityConfig, createFlowValues },
  )
  const state = new URL(authorization.authorizationURL).searchParams.get('state')
  if (!state) throw new Error('The identity authorization did not include state.')
  return { ...authorization, state }
}

const callbackURL = (state: string): URL => {
  const url = new URL(identityConfig.redirectURI)
  url.searchParams.set('code', `code-${flowSequence}`)
  url.searchParams.set('state', state)
  return url
}

describe.sequential('Xero identity flow and trust separation', () => {
  beforeAll(async () => {
    payload = await getPayload({ config })
    await clear()
    const anonymousReq = await createLocalReq({}, payload)
    const bootstrapped = await registerFirstUserOperation({
      collection: payload.collections.users,
      data: {
        active: true,
        displayName: 'Identity Owner',
        email: 'identity-owner@example.test',
        password: PASSWORD,
        role: 'owner',
        timezone: 'Pacific/Auckland',
      } as never,
      req: anonymousReq,
    })
    const owner = bootstrapped.user
    if (!owner) throw new Error('Owner bootstrap failed.')
    ownerSession = { payload, req: await requestFor(owner), user: owner }
    await payload.updateGlobal({
      slug: 'authentication-settings',
      data: {
        xeroIdentityInviteAcceptanceEnabled: true,
        xeroIdentityLinkingEnabled: true,
        xeroIdentityLoginEnabled: true,
        xeroIdentityRolloutRoles: ['owner', 'admin', 'biller', 'member'],
      },
      overrideAccess: false,
      req: ownerSession.req,
    })
    const invitation = await issueInvitation(ownerSession, {
      displayName: 'Invited Identity User',
      email: claims.email,
      role: 'member',
      timezone: 'Pacific/Auckland',
    })
    invitationToken = new URL(invitation.setupURL).searchParams.get('token') ?? ''
    if (!invitationToken) throw new Error('The invitation token was not returned in manual mode.')
  }, 60_000)

  afterAll(async () => {
    if (!payload) return
    await clear()
    await payload.destroy()
  })

  it('requires the bound invitation and matching verified Xero email', async () => {
    const mismatchFlow = await startFlow('invite-acceptance', { invitationToken })
    claims = { ...claims, email: 'different-verified-email@example.test' }
    await expect(
      completeIdentityCallback(
        payload,
        {
          browserBinding: mismatchFlow.browserBinding,
          callbackURL: callbackURL(mismatchFlow.state),
          userAgent: 'Identity integration browser',
        },
        { client, config: identityConfig },
      ),
    ).rejects.toMatchObject({ code: 'invitation-email-mismatch' })
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(1)

    claims = { ...claims, email: 'identity-invite@example.test' }
    const flow = await startFlow('invite-acceptance', { invitationToken })
    await expect(
      completeIdentityCallback(
        payload,
        {
          browserBinding: 'wrong-browser-binding-that-is-long-enough-000000000',
          callbackURL: callbackURL(flow.state),
        },
        { client, config: identityConfig },
      ),
    ).rejects.toMatchObject({ code: 'invalid-state' })
    const result = await completeIdentityCallback(
      payload,
      {
        browserBinding: flow.browserBinding,
        callbackURL: callbackURL(flow.state),
        userAgent: 'Mozilla/5.0 Chrome/130 Linux',
      },
      { client, config: identityConfig },
    )
    memberID = String(result.user.id)
    expect(result.user).toMatchObject({
      active: true,
      email: 'identity-invite@example.test',
      role: 'member',
      timezone: 'Pacific/Auckland',
    })
    expect(result.sessionToken.length).toBeGreaterThanOrEqual(40)
    memberSession = { payload, req: await requestFor(result.user), user: result.user }

    const identities = await payload.find({
      collection: 'auth-identities',
      depth: 0,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect(identities.docs).toHaveLength(1)
    originalIdentityID = String(identities.docs[0]?.id)
    expect(identities.docs[0]).toMatchObject({ status: 'active', subject: claims.subject })
    const externalSessions = await payload.find({
      collection: 'external-auth-sessions',
      depth: 0,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect(externalSessions.docs).toHaveLength(1)
    expect(JSON.stringify(externalSessions.docs)).not.toContain(result.sessionToken)
    expect(
      (await payload.count({ collection: 'xero-connections', overrideAccess: true })).totalDocs,
    ).toBe(0)

    const persistedFlows = await payload.find({
      collection: 'xero-oauth-states',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      showHiddenFields: true,
    })
    const serializedFlows = JSON.stringify(persistedFlows.docs)
    for (const input of authorizationInputs) {
      expect(serializedFlows).not.toContain(input.state)
      expect(serializedFlows).not.toContain(input.nonce)
    }
    for (const input of callbackInputs) expect(serializedFlows).not.toContain(input.pkceVerifier)
    await expect(
      completeIdentityCallback(
        payload,
        { browserBinding: flow.browserBinding, callbackURL: callbackURL(flow.state) },
        { client, config: identityConfig },
      ),
    ).rejects.toMatchObject({ code: 'invalid-state' })
  })

  it('resolves returning users by issuer/subject without changing local role or email', async () => {
    claims = {
      ...claims,
      displayName: 'Provider Display Changed',
      email: 'provider-email-changed@example.test',
    }
    const flow = await startFlow('sign-in')
    const result = await completeIdentityCallback(
      payload,
      {
        browserBinding: flow.browserBinding,
        callbackURL: callbackURL(flow.state),
        userAgent: 'Mozilla/5.0 Firefox/140 macOS',
      },
      { client, config: identityConfig },
    )
    expect(String(result.user.id)).toBe(memberID)
    const localUser = await payload.findByID({
      collection: 'users',
      depth: 0,
      id: memberID,
      overrideAccess: true,
    })
    expect(localUser).toMatchObject({
      email: 'identity-invite@example.test',
      role: 'member',
    })
    const identity = await payload.findByID({
      collection: 'auth-identities',
      depth: 0,
      id: originalIdentityID,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect(identity.emailSnapshot).toBe('provider-email-changed@example.test')

    claims = {
      ...claims,
      email: 'unknown-user@example.test',
      subject: 'unknown-uninvited-subject',
    }
    const unknownFlow = await startFlow('sign-in')
    await expect(
      completeIdentityCallback(
        payload,
        {
          browserBinding: unknownFlow.browserBinding,
          callbackURL: callbackURL(unknownFlow.state),
        },
        { client, config: identityConfig },
      ),
    ).rejects.toMatchObject({ code: 'unknown-identity' })
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(2)
  })

  it('requires recent reauthentication, supports safe relink, and keeps accounting untouched', async () => {
    claims = {
      displayName: 'Invited Identity User',
      email: 'identity-invite@example.test',
      issuer: XERO_IDENTITY_ISSUER,
      subject: 'identity-subject-001',
    }
    await payload.update({
      collection: 'users',
      data: { password: PASSWORD },
      depth: 0,
      id: memberID,
      overrideAccess: true,
      req: ownerSession.req,
    })
    const refreshedMember = await payload.findByID({
      collection: 'users',
      depth: 0,
      id: memberID,
      overrideAccess: true,
    })
    memberSession = { payload, req: await requestFor(refreshedMember), user: refreshedMember }
    await unlinkIdentity(memberSession, {
      password: PASSWORD,
      reason: 'Test a voluntary unlink while retaining password recovery.',
    })
    await expect(startFlow('identity-link', { session: memberSession })).rejects.toMatchObject({
      code: 'authentication-required',
    })

    const linkFlow = await startFlow('identity-link', {
      recentlyReauthenticated: true,
      session: memberSession,
    })
    const relinked = await completeIdentityCallback(
      payload,
      {
        browserBinding: linkFlow.browserBinding,
        callbackURL: callbackURL(linkFlow.state),
        currentSession: memberSession,
      },
      { client, config: identityConfig },
    )
    expect(String(relinked.user.id)).toBe(memberID)
    const identities = await payload.find({
      collection: 'auth-identities',
      depth: 0,
      overrideAccess: true,
      showHiddenFields: true,
      where: { user: { equals: memberID } },
    })
    expect(identities.docs).toHaveLength(1)
    expect(String(identities.docs[0]?.id)).toBe(originalIdentityID)
    expect(identities.docs[0]?.status).toBe('active')

    const accountingBefore = await payload.count({
      collection: 'xero-connections',
      overrideAccess: true,
    })
    await recoverExternalIdentityForUser(ownerSession, {
      confirmation: 'REVOKE XERO',
      password: PASSWORD,
      reason: 'Exercise administrator recovery for a compromised external identity.',
      targetUserID: memberID,
    })
    const recoveredIdentity = await payload.findByID({
      collection: 'auth-identities',
      depth: 0,
      id: originalIdentityID,
      overrideAccess: true,
      showHiddenFields: true,
    })
    expect(recoveredIdentity.status).toBe('revoked')
    const activeSessions = await payload.count({
      collection: 'external-auth-sessions',
      overrideAccess: true,
      where: { and: [{ user: { equals: memberID } }, { status: { equals: 'active' } }] },
    })
    expect(activeSessions.totalDocs).toBe(0)
    expect(
      (await payload.count({ collection: 'xero-connections', overrideAccess: true })).totalDocs,
    ).toBe(accountingBefore.totalDocs)
    const recoveryAudit = await payload.find({
      collection: 'audit-events',
      depth: 0,
      overrideAccess: true,
      where: { eventType: { equals: 'authentication.identity-recovered' } },
    })
    expect(recoveryAudit.docs).toHaveLength(1)
  })
})
