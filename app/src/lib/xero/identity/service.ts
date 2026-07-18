import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { hasActiveRole, isActiveUser } from '@/access/roles'
import { ACCOUNT_INVITATION_ACCEPTANCE_CONTEXT } from '@/lib/account-lifecycle/context'
import { findUsableInvitation } from '@/lib/account-lifecycle/service'
import { recordAuditEvent } from '@/lib/audit/service'
import { relationshipID } from '@/lib/domain/validation'
import { environment, type XeroIdentityEnvironment } from '@/lib/env'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import {
  decryptSecret,
  encryptSecret,
  hashOpaqueValue,
  opaqueHashMatches,
  randomOpaqueValue,
  type EncryptionKey,
} from '@/lib/xero/accounting/crypto'
import type {
  AuthIdentity,
  AuthenticationSetting,
  ExternalAuthSession,
  Invitation,
  User,
  XeroOauthState,
} from '@/payload-types'

import { createPKCEValues, createXeroIdentityClient, type XeroIdentityClient } from './client'
import { IDENTITY_FLOW_MAX_AGE_SECONDS } from './constants'
import { IdentityIntegrationError, type XeroIdentityClaims } from './contracts'

import type { Payload, PayloadRequest } from 'payload'
export { EXTERNAL_SESSION_COOKIE, IDENTITY_FLOW_COOKIE } from './constants'

const NONCE_PURPOSE = 'xero-identity-nonce'
const PKCE_PURPOSE = 'xero-identity-pkce-verifier'
const EXTERNAL_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const IDENTITY_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000

type ConfiguredIdentityEnvironment = Extract<XeroIdentityEnvironment, { configured: true }>
export type IdentityFlowPurpose = 'identity-link' | 'invite-acceptance' | 'sign-in'

type ServiceDependencies = {
  client?: XeroIdentityClient
  config?: ConfiguredIdentityEnvironment
  createFlowValues?: typeof createPKCEValues
  now?: () => Date
}

type IdentityAuthorizationInput = {
  invitationToken?: string
  purpose: IdentityFlowPurpose
  recentlyReauthenticated?: boolean
  returnPath?: string
  session?: AppSession | null
}

type IdentityCallbackInput = {
  browserBinding: string
  callbackURL: URL
  currentSession?: AppSession | null
  userAgent?: string | null
}

export type IdentityCallbackResult = {
  destination: string
  sessionToken: string
  user: User
}

export type IdentitySecurityView = {
  identity: null | {
    displayName?: string
    email?: string
    lastUsedAt?: string
    linkedAt: string
    status: string
  }
  sessions: Array<{
    current: boolean
    deviceLabel?: string
    expiresAt: string
    id: string
    issuedAt: string
    lastSeenAt: string
  }>
}

const configuredEnvironment = (
  override?: ConfiguredIdentityEnvironment,
): ConfiguredIdentityEnvironment => {
  if (override) return override
  if (!environment.xeroIdentity.configured) {
    throw new IdentityIntegrationError('not-configured', 'Xero identity sign-in is not configured.')
  }
  return environment.xeroIdentity
}

const encryptionKey = (config: ConfiguredIdentityEnvironment): EncryptionKey => ({
  keyHex: config.authFlowEncryptionKey,
  version: config.authFlowEncryptionKeyVersion,
})

const dependencies = (overrides: ServiceDependencies = {}) => {
  const config = configuredEnvironment(overrides.config)
  return {
    client: overrides.client ?? createXeroIdentityClient(config),
    config,
    createFlowValues: overrides.createFlowValues ?? createPKCEValues,
    now: overrides.now ?? (() => new Date()),
  }
}

const safeAppPath = (value: string | undefined): string => {
  if (!value) return '/app'
  const valid = value === '/app' || value.startsWith('/app/') || value.startsWith('/app?')
  return valid && !value.startsWith('//') && !value.includes('\\') ? value : '/app'
}

const settingsFor = async (
  payload: Payload,
  req?: PayloadRequest,
): Promise<AuthenticationSetting> =>
  payload.findGlobal({
    slug: 'authentication-settings',
    depth: 0,
    overrideAccess: true,
    req,
  })

const assertFeatureEnabled = (
  settings: AuthenticationSetting,
  purpose: IdentityFlowPurpose,
): void => {
  if (!settings.xeroIdentityLoginEnabled) {
    throw new IdentityIntegrationError('feature-disabled', 'Xero identity sign-in is disabled.')
  }
  if (purpose === 'identity-link' && !settings.xeroIdentityLinkingEnabled) {
    throw new IdentityIntegrationError('linking-disabled', 'Xero identity linking is disabled.')
  }
  if (purpose === 'invite-acceptance' && !settings.xeroIdentityInviteAcceptanceEnabled) {
    throw new IdentityIntegrationError(
      'invite-acceptance-disabled',
      'Xero invitation acceptance is disabled.',
    )
  }
}

const assertRolloutRole = (settings: AuthenticationSetting, user: User): void => {
  const roles = settings.xeroIdentityRolloutRoles ?? []
  if (!user.role || !roles.includes(user.role)) {
    throw new IdentityIntegrationError(
      'rollout-restricted',
      'Xero identity sign-in is not enabled for this account.',
    )
  }
}

const flowUserID = (flow: XeroOauthState): string | null => {
  const id = relationshipID(flow.initiatingUser)
  return id === null ? null : String(id)
}

const flowInvitationID = (flow: XeroOauthState): string | null => {
  const id = relationshipID(flow.invitation)
  return id === null ? null : String(id)
}

const findFlow = async (payload: Payload, state: string): Promise<XeroOauthState | null> => {
  if (state.length < 32 || state.length > 500) return null
  const result = await payload.find({
    collection: 'xero-oauth-states',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    showHiddenFields: true,
    where: { stateHash: { equals: hashOpaqueValue(state) } },
  })
  return result.docs[0] ?? null
}

const validatePendingFlow = (
  flow: XeroOauthState | null,
  browserBinding: string,
  now: Date,
): XeroOauthState => {
  if (
    !flow ||
    flow.family !== 'identity' ||
    flow.status !== 'pending' ||
    new Date(flow.expiresAt).getTime() <= now.getTime() ||
    browserBinding.length < 32 ||
    browserBinding.length > 500 ||
    !opaqueHashMatches(browserBinding, flow.browserBindingHash)
  ) {
    throw new IdentityIntegrationError(
      'invalid-state',
      'The Xero identity request is invalid or expired.',
    )
  }
  return flow
}

const claimFlow = async (payload: Payload, flow: XeroOauthState, now: Date): Promise<void> => {
  const claimed = await requireMongoModel(payload, 'xero-oauth-states').findOneAndUpdate(
    {
      _id: flow.id,
      expiresAt: { $gt: now },
      family: 'identity',
      status: 'pending',
    },
    { $set: { consumedAt: now, status: 'consumed' } },
    { new: true },
  )
  if (!claimed) {
    throw new IdentityIntegrationError(
      'state-replayed',
      'The Xero identity request has already been used.',
    )
  }
}

const markFlow = async (
  payload: Payload,
  flowID: string,
  status: 'completed' | 'failed',
  code?: string,
  req?: PayloadRequest,
): Promise<void> => {
  await payload.update({
    collection: 'xero-oauth-states',
    id: flowID,
    data: {
      completedAt: status === 'completed' ? new Date().toISOString() : undefined,
      failureCode: code?.slice(0, 100),
      nonceEnvelope: null,
      pkceVerifierEnvelope: null,
      status,
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
}

const browserLabel = (userAgent: string | null | undefined): string => {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const platform = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'device'
  return `${browser} on ${platform}`
}

const userAgentHash = (userAgent: string | null | undefined): string | undefined =>
  userAgent
    ? createHash('sha256').update(userAgent.slice(0, 2_000), 'utf8').digest('base64url')
    : undefined

const createExternalSession = async (
  payload: Payload,
  req: PayloadRequest,
  input: {
    identity: AuthIdentity
    settings: AuthenticationSetting
    user: User
    userAgent?: string | null
  },
): Promise<string> => {
  const token = randomOpaqueValue()
  const now = new Date()
  const idleMinutes = input.settings.externalSessionIdleMinutes ?? 10_080
  const absoluteMinutes = input.settings.externalSessionAbsoluteMinutes ?? 43_200
  const absoluteExpiresAt = new Date(now.getTime() + absoluteMinutes * 60_000)
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + idleMinutes * 60_000, absoluteExpiresAt.getTime()),
  )

  await payload.create({
    collection: 'external-auth-sessions',
    data: {
      absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      cleanupAt: new Date(
        absoluteExpiresAt.getTime() + EXTERNAL_SESSION_RETENTION_MS,
      ).toISOString(),
      deviceLabel: browserLabel(input.userAgent),
      identity: input.identity.id,
      idleExpiresAt: idleExpiresAt.toISOString(),
      issuedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      status: 'active',
      tokenHash: hashOpaqueValue(token),
      user: input.user.id,
      userAgentHash: userAgentHash(input.userAgent),
      version: 1,
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
  return token
}

const loadUser = async (
  payload: Payload,
  id: number | string,
  req?: PayloadRequest,
): Promise<User> => {
  const user = await payload.findByID({
    collection: 'users',
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })
  if (!isActiveUser(user)) {
    throw new IdentityIntegrationError('inactive-account', 'The local account is unavailable.')
  }
  return user
}

const findIdentityByClaims = async (
  payload: Payload,
  claims: XeroIdentityClaims,
  req?: PayloadRequest,
): Promise<AuthIdentity | null> => {
  const result = await payload.find({
    collection: 'auth-identities',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    showHiddenFields: true,
    where: {
      and: [
        { provider: { equals: 'xero' } },
        { issuer: { equals: claims.issuer } },
        { subject: { equals: claims.subject } },
      ],
    },
  })
  return result.docs[0] ?? null
}

const findUserIdentity = async (
  payload: Payload,
  userID: string,
  req?: PayloadRequest,
): Promise<AuthIdentity | null> => {
  const result = await payload.find({
    collection: 'auth-identities',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    showHiddenFields: true,
    where: { and: [{ user: { equals: userID } }, { provider: { equals: 'xero' } }] },
  })
  return result.docs[0] ?? null
}

const createIdentity = async (
  payload: Payload,
  req: PayloadRequest,
  user: User,
  claims: XeroIdentityClaims,
  linkedBy: number | string,
): Promise<AuthIdentity> =>
  payload.create({
    collection: 'auth-identities',
    data: {
      displayNameSnapshot: claims.displayName,
      emailSnapshot: claims.email,
      issuer: claims.issuer,
      linkedAt: new Date().toISOString(),
      linkedBy: String(linkedBy),
      provider: 'xero',
      status: 'active',
      subject: claims.subject,
      user: user.id,
    },
    depth: 0,
    overrideAccess: true,
    req,
    showHiddenFields: true,
  })

const completeReturningSignIn = async (
  payload: Payload,
  flow: XeroOauthState,
  claims: XeroIdentityClaims,
  settings: AuthenticationSetting,
  userAgent?: string | null,
): Promise<IdentityCallbackResult> =>
  withPayloadTransaction(payload, async (req) => {
    const identity = await findIdentityByClaims(payload, claims, req)
    if (!identity || identity.status !== 'active') {
      throw new IdentityIntegrationError(
        'unknown-identity',
        'Xero sign-in could not be completed for this account.',
      )
    }
    const userID = relationshipID(identity.user)
    if (userID === null) {
      throw new IdentityIntegrationError('unknown-identity', 'The local account is unavailable.')
    }
    const user = await loadUser(payload, userID, req)
    assertRolloutRole(settings, user)

    const updatedIdentity = await payload.update({
      collection: 'auth-identities',
      id: identity.id,
      data: {
        displayNameSnapshot: claims.displayName,
        emailSnapshot: claims.email,
        lastUsedAt: new Date().toISOString(),
      },
      depth: 0,
      overrideAccess: true,
      req,
      showHiddenFields: true,
    })
    await payload.update({
      collection: 'users',
      id: user.id,
      data: { lastLoginAt: new Date().toISOString(), lastLoginProvider: 'xero' },
      depth: 0,
      overrideAccess: true,
      req,
    })
    const sessionToken = await createExternalSession(payload, req, {
      identity: updatedIdentity,
      settings,
      user,
      userAgent,
    })
    await recordAuditEvent(
      payload,
      {
        actor: user.id,
        eventType: 'authentication.login-succeeded',
        metadata: { provider: 'xero' },
        targetCollection: 'users',
        targetId: user.id,
      },
      req,
    )
    await markFlow(payload, flow.id, 'completed', undefined, req)
    return { destination: safeAppPath(flow.returnPath ?? undefined), sessionToken, user }
  })

const completeLink = async (
  payload: Payload,
  flow: XeroOauthState,
  claims: XeroIdentityClaims,
  settings: AuthenticationSetting,
  currentSession: AppSession | null | undefined,
  userAgent?: string | null,
): Promise<IdentityCallbackResult> => {
  const expectedUserID = flowUserID(flow)
  if (!currentSession || !expectedUserID || String(currentSession.user.id) !== expectedUserID) {
    throw new IdentityIntegrationError('wrong-session', 'The identity link session is unavailable.')
  }

  return withPayloadTransaction(payload, async (req) => {
    const user = await loadUser(payload, currentSession.user.id, req)
    assertRolloutRole(settings, user)
    const identityByClaims = await findIdentityByClaims(payload, claims, req)
    const userIdentity = await findUserIdentity(payload, String(user.id), req)
    const canReactivate =
      identityByClaims &&
      userIdentity &&
      String(identityByClaims.id) === String(userIdentity.id) &&
      identityByClaims.status === 'revoked'
    if (!canReactivate && (identityByClaims || userIdentity)) {
      throw new IdentityIntegrationError(
        'identity-collision',
        'That Xero identity cannot be linked automatically.',
      )
    }

    const identity = canReactivate
      ? await payload.update({
          collection: 'auth-identities',
          data: {
            displayNameSnapshot: claims.displayName,
            emailSnapshot: claims.email,
            lastUsedAt: new Date().toISOString(),
            linkedAt: new Date().toISOString(),
            linkedBy: user.id,
            status: 'active',
            unlinkedAt: null,
            unlinkedBy: null,
            unlinkReason: null,
          },
          depth: 0,
          id: identityByClaims.id,
          overrideAccess: true,
          req,
          showHiddenFields: true,
        })
      : await createIdentity(payload, req, user, claims, user.id)
    await payload.update({
      collection: 'users',
      id: user.id,
      data: {
        enabledLoginMethods: ['email-password', 'xero'],
        lastLoginAt: new Date().toISOString(),
        lastLoginProvider: 'xero',
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
    const sessionToken = await createExternalSession(payload, req, {
      identity,
      settings,
      user,
      userAgent,
    })
    await recordAuditEvent(
      payload,
      {
        actor: user.id,
        eventType: 'authentication.identity-linked',
        metadata: { provider: 'xero', reactivated: Boolean(canReactivate) },
        targetCollection: 'users',
        targetId: user.id,
      },
      req,
    )
    await markFlow(payload, flow.id, 'completed', undefined, req)
    return { destination: safeAppPath(flow.returnPath ?? undefined), sessionToken, user }
  })
}

const completeInvitation = async (
  payload: Payload,
  flow: XeroOauthState,
  claims: XeroIdentityClaims,
  settings: AuthenticationSetting,
  userAgent?: string | null,
): Promise<IdentityCallbackResult> => {
  const invitationID = flowInvitationID(flow)
  if (!invitationID) {
    throw new IdentityIntegrationError('invalid-invitation', 'The invitation is unavailable.')
  }

  return withPayloadTransaction(
    payload,
    async (req) => {
      let invitation: Invitation
      try {
        invitation = await payload.findByID({
          collection: 'invitations',
          depth: 0,
          id: invitationID,
          overrideAccess: true,
          req,
          showHiddenFields: true,
        })
      } catch {
        throw new IdentityIntegrationError('invalid-invitation', 'The invitation is unavailable.')
      }
      if (
        invitation.status !== 'pending' ||
        new Date(invitation.expiresAt).getTime() <= Date.now() ||
        invitation.email.trim().toLowerCase() !== claims.email.trim().toLowerCase()
      ) {
        throw new IdentityIntegrationError(
          'invitation-email-mismatch',
          'The Xero identity does not match this invitation.',
        )
      }
      if (await findIdentityByClaims(payload, claims, req)) {
        throw new IdentityIntegrationError(
          'identity-collision',
          'That Xero identity cannot accept this invitation.',
        )
      }

      const transactionID = await req.transactionID
      const mongoSession = transactionID ? payload.db.sessions[transactionID] : undefined
      const claimed = await requireMongoModel(payload, 'invitations').findOneAndUpdate(
        {
          _id: invitation.id,
          expiresAt: { $gt: new Date() },
          status: 'pending',
        },
        { $set: { status: 'accepting' } },
        { new: true, session: mongoSession },
      )
      if (!claimed) {
        throw new IdentityIntegrationError('invalid-invitation', 'The invitation is unavailable.')
      }

      const users = await payload.find({
        collection: 'users',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        req,
        where: { email: { equals: invitation.email } },
      })
      if (users.docs.length > 0) {
        throw new IdentityIntegrationError('invalid-invitation', 'The invitation is unavailable.')
      }

      const user = await payload.create({
        collection: 'users',
        data: {
          _verified: true,
          active: true,
          displayName: invitation.displayName,
          email: invitation.email,
          enabledLoginMethods: ['email-password', 'xero'],
          lastLoginAt: new Date().toISOString(),
          lastLoginProvider: 'xero',
          password: randomBytes(48).toString('base64url'),
          role: invitation.role,
          timezone: invitation.timezone,
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      const identity = await createIdentity(payload, req, user, claims, user.id)
      await payload.update({
        collection: 'invitations',
        id: invitation.id,
        data: {
          acceptanceProvider: 'xero',
          acceptedAt: new Date().toISOString(),
          acceptedBy: user.id,
          cleanupAt: new Date(Date.now() + IDENTITY_RETENTION_MS).toISOString(),
          status: 'accepted',
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      const sessionToken = await createExternalSession(payload, req, {
        identity,
        settings,
        user,
        userAgent,
      })
      await recordAuditEvent(
        payload,
        {
          actor: user.id,
          eventType: 'invitation.accepted',
          metadata: { acceptanceProvider: 'xero' },
          targetCollection: 'invitations',
          targetId: invitation.id,
        },
        req,
      )
      await recordAuditEvent(
        payload,
        {
          actor: user.id,
          eventType: 'authentication.identity-linked',
          metadata: { provider: 'xero', source: 'invitation' },
          targetCollection: 'users',
          targetId: user.id,
        },
        req,
      )
      await markFlow(payload, flow.id, 'completed', undefined, req)
      return { destination: '/app', sessionToken, user }
    },
    { context: { [ACCOUNT_INVITATION_ACCEPTANCE_CONTEXT]: true } },
  )
}

export async function createIdentityAuthorization(
  payload: Payload,
  input: IdentityAuthorizationInput,
  overrides: ServiceDependencies = {},
): Promise<{ authorizationURL: string; browserBinding: string }> {
  const resolved = dependencies(overrides)
  const settings = await settingsFor(payload, input.session?.req)
  assertFeatureEnabled(settings, input.purpose)

  let invitation: Invitation | null = null
  if (input.purpose === 'identity-link') {
    if (
      !input.session ||
      !isActiveUser(input.session.user) ||
      input.recentlyReauthenticated !== true
    ) {
      throw new IdentityIntegrationError('authentication-required', 'Sign in before linking Xero.')
    }
    assertRolloutRole(settings, input.session.user)
  } else if (input.purpose === 'invite-acceptance') {
    invitation = await findUsableInvitation(payload, input.invitationToken ?? '')
    if (!invitation) {
      throw new IdentityIntegrationError('invalid-invitation', 'The invitation is unavailable.')
    }
  }

  const values = await resolved.createFlowValues()
  const browserBinding = randomOpaqueValue()
  const now = resolved.now()
  const expiresAt = new Date(now.getTime() + IDENTITY_FLOW_MAX_AGE_SECONDS * 1_000)
  await payload.create({
    collection: 'xero-oauth-states',
    data: {
      browserBindingHash: hashOpaqueValue(browserBinding),
      expiresAt: expiresAt.toISOString(),
      family: 'identity',
      initiatingUser: input.session?.user.id,
      invitation: invitation?.id,
      nonceEnvelope: encryptSecret(values.nonce, NONCE_PURPOSE, encryptionKey(resolved.config)),
      pkceVerifierEnvelope: encryptSecret(
        values.pkceVerifier,
        PKCE_PURPOSE,
        encryptionKey(resolved.config),
      ),
      purpose: input.purpose,
      returnPath: safeAppPath(input.returnPath),
      stateHash: hashOpaqueValue(values.state),
      status: 'pending',
    },
    overrideAccess: true,
    req: input.session?.req,
  })

  return {
    authorizationURL: await resolved.client.authorizationURL({
      nonce: values.nonce,
      pkceChallenge: values.pkceChallenge,
      state: values.state,
    }),
    browserBinding,
  }
}

export async function completeIdentityCallback(
  payload: Payload,
  input: IdentityCallbackInput,
  overrides: ServiceDependencies = {},
): Promise<IdentityCallbackResult> {
  const resolved = dependencies(overrides)
  const stateValue = input.callbackURL.searchParams.get('state') ?? ''
  const flow = validatePendingFlow(
    await findFlow(payload, stateValue),
    input.browserBinding,
    resolved.now(),
  )

  if (
    flow.purpose !== 'sign-in' &&
    flow.purpose !== 'identity-link' &&
    flow.purpose !== 'invite-acceptance'
  ) {
    throw new IdentityIntegrationError('wrong-purpose', 'The identity request purpose is invalid.')
  }
  if (flow.purpose === 'identity-link') {
    const expectedUserID = flowUserID(flow)
    if (!input.currentSession || String(input.currentSession.user.id) !== expectedUserID) {
      throw new IdentityIntegrationError(
        'wrong-session',
        'The identity link session is unavailable.',
      )
    }
  }

  await claimFlow(payload, flow, resolved.now())
  try {
    if (!flow.nonceEnvelope || !flow.pkceVerifierEnvelope) {
      throw new IdentityIntegrationError('invalid-state', 'The identity request is incomplete.')
    }
    const nonce = decryptSecret(flow.nonceEnvelope, NONCE_PURPOSE, encryptionKey(resolved.config))
    const pkceVerifier = decryptSecret(
      flow.pkceVerifierEnvelope,
      PKCE_PURPOSE,
      encryptionKey(resolved.config),
    )
    const canonicalCallback = new URL(resolved.config.redirectURI)
    canonicalCallback.search = input.callbackURL.search
    const claims = await resolved.client.exchangeCallback({
      callbackURL: canonicalCallback,
      expectedNonce: nonce,
      expectedState: stateValue,
      pkceVerifier,
    })

    const settings = await settingsFor(payload)
    assertFeatureEnabled(settings, flow.purpose)
    if (flow.purpose === 'sign-in') {
      return await completeReturningSignIn(payload, flow, claims, settings, input.userAgent)
    }
    if (flow.purpose === 'identity-link') {
      return await completeLink(
        payload,
        flow,
        claims,
        settings,
        input.currentSession,
        input.userAgent,
      )
    }
    return await completeInvitation(payload, flow, claims, settings, input.userAgent)
  } catch (error) {
    const code = error instanceof IdentityIntegrationError ? error.code : 'identity-callback-failed'
    await markFlow(payload, flow.id, 'failed', code)
    await recordAuditEvent(payload, {
      eventType:
        code === 'identity-collision'
          ? 'authentication.identity-collision'
          : 'authentication.login-failed',
      machineActor: 'xero-identity-callback',
      metadata: { code, purpose: flow.purpose },
      targetCollection: 'xero-oauth-states',
      targetId: flow.id,
    })
    if (error instanceof IdentityIntegrationError) throw error
    throw new IdentityIntegrationError(
      'identity-callback-failed',
      'Xero sign-in could not be completed.',
      { cause: error },
    )
  }
}

export async function rejectIdentityCallback(
  payload: Payload,
  input: { browserBinding: string; state: string },
): Promise<void> {
  const flow = validatePendingFlow(
    await findFlow(payload, input.state),
    input.browserBinding,
    new Date(),
  )
  await claimFlow(payload, flow, new Date())
  await markFlow(payload, flow.id, 'failed', 'authorization-denied')
}

export async function confirmIdentityLinkPassword(
  session: AppSession,
  password: string,
): Promise<string> {
  if (password.length === 0 || password.length > 1_024) {
    throw new IdentityIntegrationError('reauthentication-failed', 'Password confirmation failed.')
  }
  try {
    const login = await session.payload.login({
      collection: 'users',
      data: { email: session.user.email, password },
    })
    if (!login.token || !login.user || String(login.user.id) !== String(session.user.id)) {
      throw new Error('Password confirmation returned another account.')
    }
    return login.token
  } catch (error) {
    throw new IdentityIntegrationError('reauthentication-failed', 'Password confirmation failed.', {
      cause: error,
    })
  }
}

export async function getIdentitySecurityView(
  session: AppSession,
  currentRawToken?: string,
): Promise<IdentitySecurityView> {
  const identity = await findUserIdentity(session.payload, String(session.user.id), session.req)
  const sessions = await session.payload.find({
    collection: 'external-auth-sessions',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
    sort: '-lastSeenAt',
    where: {
      and: [
        { user: { equals: session.user.id } },
        { status: { equals: 'active' } },
        { absoluteExpiresAt: { greater_than: new Date().toISOString() } },
      ],
    },
  })
  const currentHash = currentRawToken ? hashOpaqueValue(currentRawToken) : null
  return {
    identity: identity
      ? {
          displayName: identity.displayNameSnapshot ?? undefined,
          email: identity.emailSnapshot ?? undefined,
          lastUsedAt: identity.lastUsedAt ?? undefined,
          linkedAt: identity.linkedAt,
          status: identity.status,
        }
      : null,
    sessions: sessions.docs.map((externalSession) => ({
      current: currentHash === externalSession.tokenHash,
      deviceLabel: externalSession.deviceLabel ?? undefined,
      expiresAt: externalSession.absoluteExpiresAt,
      id: String(externalSession.id),
      issuedAt: externalSession.issuedAt,
      lastSeenAt: externalSession.lastSeenAt,
    })),
  }
}

const revokeSessionDocument = async (
  payload: Payload,
  externalSession: ExternalAuthSession,
  reason: string,
  req?: PayloadRequest,
): Promise<void> => {
  const now = new Date()
  await payload.update({
    collection: 'external-auth-sessions',
    id: externalSession.id,
    data: {
      cleanupAt: new Date(now.getTime() + EXTERNAL_SESSION_RETENTION_MS).toISOString(),
      revocationReason: reason.slice(0, 1_000),
      revokedAt: now.toISOString(),
      status: 'revoked',
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
}

export async function revokeCurrentExternalSession(
  payload: Payload,
  rawToken: string | undefined,
): Promise<void> {
  if (!rawToken || rawToken.length > 500) return
  const result = await payload.find({
    collection: 'external-auth-sessions',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    showHiddenFields: true,
    where: { tokenHash: { equals: hashOpaqueValue(rawToken) } },
  })
  const session = result.docs[0]
  if (session?.status === 'active') await revokeSessionDocument(payload, session, 'logout')
}

export async function revokeExternalSession(session: AppSession, sessionID: string): Promise<void> {
  let externalSession: ExternalAuthSession
  try {
    externalSession = await session.payload.findByID({
      collection: 'external-auth-sessions',
      depth: 0,
      id: sessionID,
      overrideAccess: true,
      req: session.req,
      showHiddenFields: true,
    })
  } catch {
    throw new IdentityIntegrationError('invalid-session', 'That session is unavailable.')
  }
  if (String(relationshipID(externalSession.user)) !== String(session.user.id)) {
    throw new IdentityIntegrationError('forbidden', 'That session is unavailable.')
  }
  if (externalSession.status === 'active') {
    await revokeSessionDocument(session.payload, externalSession, 'user-requested', session.req)
    await recordAuditEvent(
      session.payload,
      {
        actor: session.user.id,
        eventType: 'authentication.session-revoked',
        targetCollection: 'external-auth-sessions',
        targetId: externalSession.id,
      },
      session.req,
    )
  }
}

export async function unlinkIdentity(
  session: AppSession,
  input: { password: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim()
  if (reason.length < 3 || reason.length > 1_000) {
    throw new IdentityIntegrationError('invalid-reason', 'Enter a reason for unlinking Xero.')
  }
  await confirmIdentityLinkPassword(session, input.password)
  const identity = await findUserIdentity(session.payload, String(session.user.id), session.req)
  if (!identity || identity.status !== 'active') {
    throw new IdentityIntegrationError('identity-unavailable', 'No linked Xero identity was found.')
  }

  await withPayloadTransaction(session.payload, async (req) => {
    const now = new Date().toISOString()
    await session.payload.update({
      collection: 'auth-identities',
      id: identity.id,
      data: {
        status: 'revoked',
        unlinkedAt: now,
        unlinkedBy: session.user.id,
        unlinkReason: reason,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
    const externalSessions = await session.payload.find({
      collection: 'external-auth-sessions',
      depth: 0,
      limit: 1_000,
      overrideAccess: true,
      req,
      where: { and: [{ identity: { equals: identity.id } }, { status: { equals: 'active' } }] },
    })
    for (const externalSession of externalSessions.docs) {
      await revokeSessionDocument(session.payload, externalSession, 'identity-unlinked', req)
    }
    await session.payload.update({
      collection: 'users',
      id: session.user.id,
      data: { enabledLoginMethods: ['email-password'] },
      depth: 0,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(
      session.payload,
      {
        actor: session.user.id,
        eventType: 'authentication.identity-unlinked',
        reason,
        targetCollection: 'auth-identities',
        targetId: identity.id,
      },
      req,
    )
  })
}

export async function recoverExternalIdentityForUser(
  session: AppSession,
  input: {
    confirmation: string
    password: string
    reason: string
    targetUserID: string
  },
): Promise<void> {
  if (!hasActiveRole(session.user, ['owner', 'admin'])) {
    throw new IdentityIntegrationError(
      'forbidden',
      'Only an owner or administrator can recover an identity link.',
    )
  }
  const reason = input.reason.trim()
  if (reason.length < 10 || reason.length > 1_000) {
    throw new IdentityIntegrationError(
      'invalid-reason',
      'Enter an identity recovery reason of at least 10 characters.',
    )
  }
  if (input.confirmation.trim() !== 'REVOKE XERO') {
    throw new IdentityIntegrationError(
      'confirmation-required',
      'Enter REVOKE XERO to confirm identity recovery.',
    )
  }
  if (!/^[a-f0-9]{24}$/i.test(input.targetUserID)) {
    throw new IdentityIntegrationError('invalid-user', 'Select a valid user.')
  }
  await confirmIdentityLinkPassword(session, input.password)

  await withPayloadTransaction(session.payload, async (req) => {
    let target: User
    try {
      target = await session.payload.findByID({
        collection: 'users',
        depth: 0,
        id: input.targetUserID,
        overrideAccess: true,
        req,
      })
    } catch {
      throw new IdentityIntegrationError('invalid-user', 'Select a valid user.')
    }
    if (target.role === 'owner' && session.user.role !== 'owner') {
      throw new IdentityIntegrationError(
        'owner-recovery-required',
        'Only an owner can recover another owner identity.',
      )
    }
    if (!target.email || target._verified === false) {
      throw new IdentityIntegrationError(
        'no-recovery-method',
        'The target must retain a verified email/password recovery method.',
      )
    }

    const identity = await findUserIdentity(session.payload, String(target.id), req)
    if (!identity || identity.status === 'revoked') {
      throw new IdentityIntegrationError(
        'identity-unavailable',
        'No active Xero identity link was found.',
      )
    }
    const now = new Date().toISOString()
    await session.payload.update({
      collection: 'auth-identities',
      data: {
        status: 'revoked',
        unlinkedAt: now,
        unlinkedBy: session.user.id,
        unlinkReason: reason,
      },
      depth: 0,
      id: identity.id,
      overrideAccess: true,
      req,
    })
    await revokeAllExternalSessionsForUser(
      session.payload,
      target.id,
      'administrator-identity-recovery',
      req,
    )
    await session.payload.update({
      collection: 'users',
      data: { enabledLoginMethods: ['email-password'], sessions: [] },
      depth: 0,
      id: target.id,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(
      session.payload,
      {
        actor: session.user.id,
        eventType: 'authentication.identity-recovered',
        metadata: { provider: 'xero', sessionsRevoked: true },
        reason,
        targetCollection: 'users',
        targetId: target.id,
      },
      req,
    )
  })
}

export async function revokeAllExternalSessionsForUser(
  payload: Payload,
  userID: number | string,
  reason: string,
  req?: PayloadRequest,
): Promise<void> {
  const sessions = await payload.find({
    collection: 'external-auth-sessions',
    depth: 0,
    limit: 1_000,
    overrideAccess: true,
    req,
    where: { and: [{ user: { equals: userID } }, { status: { equals: 'active' } }] },
  })
  for (const externalSession of sessions.docs) {
    await revokeSessionDocument(payload, externalSession, reason, req)
  }
}

export async function revokeExternalIdentityForUser(
  payload: Payload,
  userID: number | string,
  reason: string,
  req: PayloadRequest,
): Promise<void> {
  const identities = await payload.find({
    collection: 'auth-identities',
    depth: 0,
    limit: 10,
    overrideAccess: true,
    req,
    where: { and: [{ user: { equals: userID } }, { status: { equals: 'active' } }] },
  })
  const now = new Date().toISOString()
  for (const identity of identities.docs) {
    await payload.update({
      collection: 'auth-identities',
      data: {
        status: 'revoked',
        unlinkedAt: now,
        unlinkedBy: req.user?.id,
        unlinkReason: reason,
      },
      depth: 0,
      id: identity.id,
      overrideAccess: true,
      req,
    })
    await recordAuditEvent(
      payload,
      {
        actor: req.user?.id,
        eventType: 'authentication.identity-unlinked',
        metadata: { source: 'user-offboarding' },
        reason,
        targetCollection: 'auth-identities',
        targetId: identity.id,
      },
      req,
    )
  }
}

export const identityFeatureView = async (
  payload: Payload,
): Promise<{
  configured: boolean
  inviteAcceptanceEnabled: boolean
  linkingEnabled: boolean
  loginEnabled: boolean
}> => {
  const settings = await settingsFor(payload)
  return {
    configured: environment.xeroIdentity.configured,
    inviteAcceptanceEnabled: Boolean(settings.xeroIdentityInviteAcceptanceEnabled),
    linkingEnabled: Boolean(settings.xeroIdentityLinkingEnabled),
    loginEnabled: Boolean(settings.xeroIdentityLoginEnabled),
  }
}

export const isIdentityAdministrator = (session: AppSession | null): session is AppSession =>
  Boolean(session && hasActiveRole(session.user, ['owner', 'admin']))
