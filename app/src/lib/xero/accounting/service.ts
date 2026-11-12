import 'server-only'

import { createLocalReq, type Payload } from 'payload'

import { recordAuditEvent } from '@/lib/audit/service'
import { isRecord, relationshipID } from '@/lib/domain/validation'
import { environment } from '@/lib/env'
import type { AppSession } from '@/lib/member-app/session'
import { requireMongoModel } from '@/lib/payload/mongo'
import { withPayloadTransaction } from '@/lib/payload/withTransaction'
import { resumeExportsAwaitingReconnect } from '@/lib/xero/export/resume'
import type { XeroConnection, XeroOauthState } from '@/payload-types'

import { createXeroAccountingClient, type XeroAccountingClient } from './client'
import {
  AccountingIntegrationError,
  REQUIRED_ACCOUNTING_SCOPES,
  parseConnectionsResponse,
  validateAccountingScopes,
  type XeroAccountingRuntimeConfig,
  type XeroConnectionCandidate,
  type XeroTokenSet,
} from './contracts'
import {
  decryptSecret,
  deriveEncryptionKey,
  encryptSecret,
  hashOpaqueValue,
  opaqueHashMatches,
  randomOpaqueValue,
  type EncryptionKey,
} from './crypto'
import { connectionFailureMessage } from './recovery'
import { validateAccountingAccessToken, type AccountingAccessTokenMetadata } from './token'

export const ACCOUNTING_FLOW_COOKIE = 'xero-accounting-flow'
export const ACCOUNTING_FLOW_MAX_AGE_SECONDS = 10 * 60

const CONNECTION_SINGLETON_KEY = 'business-accounting'
const ACCESS_TOKEN_PURPOSE = 'xero-accounting-access-token'
const CLIENT_SECRET_PURPOSE = 'xero-accounting-oauth-client-secret'
const REFRESH_TOKEN_PURPOSE = 'xero-accounting-refresh-token'
const PENDING_GRANT_PURPOSE = 'xero-accounting-pending-grant'
const CONFIGURATION_KEY_PURPOSE = 'xero-accounting-configuration-key'
const TOKEN_KEY_PURPOSE = 'xero-accounting-token-key'
const ACCOUNTING_KEY_VERSION = 1
const ACCESS_REFRESH_SKEW_MS = 2 * 60 * 1_000

type ConfiguredAccountingEnvironment = XeroAccountingRuntimeConfig

type ServiceDependencies = {
  client?: XeroAccountingClient
  config?: ConfiguredAccountingEnvironment
  validateAccessToken?: (
    accessToken: string,
    config: ConfiguredAccountingEnvironment,
  ) => Promise<AccountingAccessTokenMetadata>
}

type PendingGrant = {
  metadata: AccountingAccessTokenMetadata
  tokenSet: XeroTokenSet
}

/** Builds an internal request for durable jobs without granting any HTTP caller system authority. */
export async function createAccountingSystemSession(payload: Payload): Promise<AppSession> {
  const users = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    sort: 'createdAt',
  })
  const user = users.docs[0]
  if (!user) {
    throw new AccountingIntegrationError(
      'missing-system-owner',
      'Create the app user before running accounting jobs.',
    )
  }
  const req = await createLocalReq({ user }, payload)
  return { payload, req, user }
}

export type AccountingConnectionView = {
  authorizedAt?: string
  callbackURI: string
  clientID?: string
  clientSecretConfigured: boolean
  configured: boolean
  connectionId?: string
  disconnectedAt?: string
  disconnectReason?: string
  grantedScopes: string[]
  initiatedBy?: string
  lastErrorCode?: string
  lastErrorMessage?: string
  lastHealthCheckAt?: string
  lastReferenceDataSyncAt?: string
  lastRefreshedAt?: string
  oauthConfiguredAt?: string
  status: 'action-required' | 'connected' | 'disconnected' | 'not-connected' | 'not-configured'
  tenantId?: string
  tenantName?: string
  xeroUserId?: string
}

export type TenantSelection = {
  connections: XeroConnectionCandidate[]
  flowID: string
}

const findConnection = async (session: AppSession): Promise<XeroConnection | null> => {
  const result = await session.payload.find({
    collection: 'xero-connections',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req: session.req,
    showHiddenFields: true,
    where: { singletonKey: { equals: CONNECTION_SINGLETON_KEY } },
  })

  return result.docs[0] ?? null
}

const callbackURI = (): string =>
  new URL('/api/integrations/xero/accounting/callback', environment.serverURL).toString()

const configurationEncryptionKey = (): EncryptionKey =>
  deriveEncryptionKey(environment.payloadSecret, CONFIGURATION_KEY_PURPOSE, ACCOUNTING_KEY_VERSION)

const derivedTokenEncryptionKey = (): EncryptionKey =>
  deriveEncryptionKey(environment.payloadSecret, TOKEN_KEY_PURPOSE, ACCOUNTING_KEY_VERSION)

const encryptionKey = (config: ConfiguredAccountingEnvironment): EncryptionKey => ({
  keyHex: config.tokenEncryptionKey,
  version: config.tokenEncryptionKeyVersion,
})

type ConfiguredConnection = XeroConnection & {
  oauthClientId: string
  oauthClientSecretEnvelope: string
}

const hasPersistedConfiguration = (
  connection: XeroConnection | null,
): connection is ConfiguredConnection =>
  Boolean(connection?.oauthClientId && connection.oauthClientSecretEnvelope)

const configuredEnvironment = async (
  session: AppSession,
  override?: ConfiguredAccountingEnvironment,
): Promise<ConfiguredAccountingEnvironment> => {
  if (override) return override
  const connection = await findConnection(session)
  if (!hasPersistedConfiguration(connection)) {
    throw new AccountingIntegrationError(
      'not-configured',
      'The Xero accounting integration is not configured.',
    )
  }

  const clientSecret = decryptSecret(
    connection.oauthClientSecretEnvelope,
    CLIENT_SECRET_PURPOSE,
    configurationEncryptionKey(),
  )
  const tokenKey = derivedTokenEncryptionKey()

  return {
    clientID: connection.oauthClientId,
    clientSecret,
    configured: true,
    redirectURI: callbackURI(),
    tokenEncryptionKey: tokenKey.keyHex,
    tokenEncryptionKeyVersion: tokenKey.version,
  }
}

const dependencies = async (session: AppSession, overrides: ServiceDependencies = {}) => {
  const config = await configuredEnvironment(session, overrides.config)
  return {
    client: overrides.client ?? createXeroAccountingClient(config),
    config,
    validateAccessToken: overrides.validateAccessToken ?? validateAccountingAccessToken,
  }
}

export async function resolveAccountingRuntime(
  session: AppSession,
  overrides: ServiceDependencies = {},
): Promise<{
  client: XeroAccountingClient
  config: ConfiguredAccountingEnvironment
  validateAccessToken: NonNullable<ServiceDependencies['validateAccessToken']>
}> {
  return dependencies(session, overrides)
}

const credential = (
  value: string,
  options: { label: string; max: number; min: number },
): string => {
  const normalized = value.trim()
  if (
    normalized.length < options.min ||
    normalized.length > options.max ||
    /[\s\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AccountingIntegrationError(
      `invalid-${options.label.toLowerCase().replaceAll(' ', '-')}`,
      `Enter a valid ${options.label}.`,
    )
  }
  return normalized
}

export async function configureAccountingOAuth(
  session: AppSession,
  input: { clientID: string; clientSecret: string },
): Promise<void> {
  const clientID = credential(input.clientID, { label: 'client ID', max: 200, min: 5 })
  const suppliedSecret = input.clientSecret.trim()

  await withPayloadTransaction(
    session.payload,
    async (req) => {
      const transactionSession: AppSession = { ...session, req }
      const current = await findConnection(transactionSession)
      if (current?.status === 'connected') {
        throw new AccountingIntegrationError(
          'disconnect-before-config-change',
          'Disconnect Xero accounting before replacing its OAuth application credentials.',
        )
      }

      const clientSecret = suppliedSecret
        ? credential(suppliedSecret, { label: 'client secret', max: 500, min: 10 })
        : current?.oauthClientSecretEnvelope
          ? decryptSecret(
              current.oauthClientSecretEnvelope,
              CLIENT_SECRET_PURPOSE,
              configurationEncryptionKey(),
            )
          : ''
      if (!clientSecret) {
        throw new AccountingIntegrationError(
          'invalid-client-secret',
          'Enter the Xero accounting client secret.',
        )
      }

      const now = new Date().toISOString()
      const data = {
        accessTokenEnvelope: null,
        accessTokenExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        oauthClientId: clientID,
        oauthClientSecretEnvelope: suppliedSecret
          ? encryptSecret(clientSecret, CLIENT_SECRET_PURPOSE, configurationEncryptionKey())
          : current?.oauthClientSecretEnvelope,
        oauthConfigurationVersion: (current?.oauthConfigurationVersion ?? 0) + 1,
        oauthConfiguredAt: now,
        oauthConfiguredBy: session.user.id,
        refreshLockExpiresAt: null,
        refreshLockId: null,
        refreshTokenEnvelope: null,
        singletonKey: CONNECTION_SINGLETON_KEY,
        status: 'disconnected' as const,
        tokenVersion: current ? current.tokenVersion + 1 : 0,
      }
      const updated = current
        ? await session.payload.update({
            collection: 'xero-connections',
            id: current.id,
            data,
            overrideAccess: true,
            req,
            showHiddenFields: true,
          })
        : await session.payload.create({
            collection: 'xero-connections',
            data,
            overrideAccess: true,
            req,
            showHiddenFields: true,
          })

      if (current) {
        await session.payload.update({
          collection: 'xero-oauth-states',
          data: {
            failureCode: 'accounting-configuration-changed',
            status: 'failed',
          },
          overrideAccess: true,
          req,
          where: { status: { in: ['pending', 'awaiting-selection'] } },
        })
      }

      await recordAuditEvent(
        session.payload,
        {
          actor: session.user.id,
          after: { clientID, credentialConfigured: true },
          before: {
            clientID: current?.oauthClientId ?? null,
            credentialConfigured: Boolean(current?.oauthClientSecretEnvelope),
          },
          eventType: 'xero.accounting-configuration-changed',
          targetCollection: 'xero-connections',
          targetId: updated.id,
        },
        req,
      )
    },
    { user: session.user },
  )
}

const safeConnectionView = (connection: XeroConnection): AccountingConnectionView => {
  const initiatedBy = relationshipID(connection.initiatedBy)

  return {
    authorizedAt: connection.authorizedAt ?? undefined,
    callbackURI: callbackURI(),
    clientID: connection.oauthClientId ?? undefined,
    clientSecretConfigured: Boolean(connection.oauthClientSecretEnvelope),
    configured: true,
    connectionId: connection.connectionId ?? undefined,
    disconnectedAt: connection.disconnectedAt ?? undefined,
    disconnectReason: connection.disconnectReason ?? undefined,
    grantedScopes: connection.grantedScopes ?? [],
    initiatedBy: initiatedBy === null ? undefined : String(initiatedBy),
    lastErrorCode: connection.lastErrorCode ?? undefined,
    lastErrorMessage: connection.lastErrorMessage ?? undefined,
    lastHealthCheckAt: connection.lastHealthCheckAt ?? undefined,
    lastReferenceDataSyncAt: connection.lastReferenceDataSyncAt ?? undefined,
    lastRefreshedAt: connection.lastRefreshedAt ?? undefined,
    oauthConfiguredAt: connection.oauthConfiguredAt ?? undefined,
    status: connection.status,
    tenantId: connection.tenantId ?? undefined,
    tenantName: connection.tenantName ?? undefined,
    xeroUserId: connection.authorizingXeroUserId ?? undefined,
  }
}

export async function getAccountingConnectionView(
  session: AppSession,
): Promise<AccountingConnectionView> {
  const connection = await findConnection(session)
  return hasPersistedConfiguration(connection)
    ? safeConnectionView(connection)
    : {
        callbackURI: callbackURI(),
        clientSecretConfigured: false,
        configured: false,
        grantedScopes: [],
        status: 'not-configured',
      }
}

export async function createAccountingAuthorization(
  session: AppSession,
  overrides: Pick<ServiceDependencies, 'config'> = {},
): Promise<{ authorizationURL: string; browserBinding: string }> {
  const config = await configuredEnvironment(session, overrides.config)
  const connection = await findConnection(session)

  if (connection?.status === 'connected') {
    throw new AccountingIntegrationError(
      'already-connected',
      'A Xero organisation is already connected.',
    )
  }

  const purpose = connection?.tenantId ? 'reconnect' : 'initial-connect'
  const state = randomOpaqueValue()
  const browserBinding = randomOpaqueValue()
  const expiresAt = new Date(Date.now() + ACCOUNTING_FLOW_MAX_AGE_SECONDS * 1_000).toISOString()

  await session.payload.create({
    collection: 'xero-oauth-states',
    data: {
      browserBindingHash: hashOpaqueValue(browserBinding),
      expiresAt,
      family: 'accounting',
      initiatingUser: session.user.id,
      pinnedTenantId: connection?.tenantId ?? undefined,
      purpose,
      stateHash: hashOpaqueValue(state),
      status: 'pending',
    },
    overrideAccess: true,
    req: session.req,
  })

  const authorizationURL = new URL('https://login.xero.com/identity/connect/authorize')
  authorizationURL.search = new URLSearchParams({
    client_id: config.clientID,
    redirect_uri: config.redirectURI,
    response_type: 'code',
    scope: REQUIRED_ACCOUNTING_SCOPES.join(' '),
    state,
  }).toString()

  return { authorizationURL: authorizationURL.toString(), browserBinding }
}

const stateUserID = (state: XeroOauthState): string | null => {
  const id = relationshipID(state.initiatingUser)
  return id === null ? null : String(id)
}

const findStateByHash = async (
  session: AppSession,
  stateHash: string,
): Promise<XeroOauthState | null> => {
  const result = await session.payload.find({
    collection: 'xero-oauth-states',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
    where: { stateHash: { equals: stateHash } },
  })
  return result.docs[0] ?? null
}

const validateBoundState = (
  state: XeroOauthState | null,
  session: AppSession,
  browserBinding: string,
  expectedStatus: XeroOauthState['status'],
): XeroOauthState => {
  if (
    !state ||
    state.family !== 'accounting' ||
    state.status !== expectedStatus ||
    stateUserID(state) !== String(session.user.id) ||
    new Date(state.expiresAt).getTime() <= Date.now() ||
    !opaqueHashMatches(browserBinding, state.browserBindingHash)
  ) {
    throw new AccountingIntegrationError(
      'invalid-state',
      'The Xero accounting authorization is invalid or expired.',
    )
  }
  return state
}

const bulkClaimState = async (
  session: AppSession,
  id: string,
  fromStatus: XeroOauthState['status'],
): Promise<XeroOauthState> => {
  const claimed = await requireMongoModel(session.payload, 'xero-oauth-states').findOneAndUpdate(
    {
      _id: id,
      expiresAt: { $gt: new Date() },
      status: fromStatus,
    },
    {
      $set: {
        consumedAt: new Date(),
        status: 'consumed',
      },
    },
    { new: true },
  )

  if (!claimed) {
    throw new AccountingIntegrationError(
      'state-replayed',
      'The Xero accounting authorization has already been used.',
    )
  }

  return session.payload.findByID({
    collection: 'xero-oauth-states',
    depth: 0,
    id,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
}

const markStateFailed = async (
  session: AppSession,
  stateID: string,
  code: string,
): Promise<void> => {
  await session.payload.update({
    collection: 'xero-oauth-states',
    id: stateID,
    data: { failureCode: code.slice(0, 100), status: 'failed' },
    overrideAccess: true,
    req: session.req,
  })
}

const grantsMatch = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((scope) => right.includes(scope))

const parsePendingGrant = (
  envelope: string,
  config: ConfiguredAccountingEnvironment,
): PendingGrant => {
  let parsed: unknown
  try {
    parsed = JSON.parse(decryptSecret(envelope, PENDING_GRANT_PURPOSE, encryptionKey(config)))
  } catch (error) {
    if (error instanceof AccountingIntegrationError) throw error
    throw new AccountingIntegrationError(
      'invalid-pending-grant',
      'The pending Xero authorization could not be read.',
      { cause: error },
    )
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AccountingIntegrationError(
      'invalid-pending-grant',
      'The pending Xero authorization is invalid.',
    )
  }

  const value = parsed as Record<string, unknown>
  const token = value.tokenSet as Record<string, unknown> | undefined
  const metadata = value.metadata as Record<string, unknown> | undefined
  if (!token || !metadata) {
    throw new AccountingIntegrationError(
      'invalid-pending-grant',
      'The pending Xero authorization is invalid.',
    )
  }

  const scopes = validateAccountingScopes(token.scopes)
  const metadataScopes = validateAccountingScopes(metadata.scopes)
  if (
    typeof token.accessToken !== 'string' ||
    typeof token.refreshToken !== 'string' ||
    typeof token.expiresIn !== 'number' ||
    !Number.isSafeInteger(token.expiresIn) ||
    token.expiresIn < 60 ||
    token.expiresIn > 3_600 ||
    typeof metadata.authenticationEventId !== 'string' ||
    typeof metadata.xeroUserId !== 'string' ||
    !grantsMatch(scopes, metadataScopes)
  ) {
    throw new AccountingIntegrationError(
      'invalid-pending-grant',
      'The pending Xero authorization is invalid.',
    )
  }

  return {
    metadata: {
      authenticationEventId: metadata.authenticationEventId,
      scopes: metadataScopes,
      xeroUserId: metadata.xeroUserId,
    },
    tokenSet: {
      accessToken: token.accessToken,
      expiresIn: token.expiresIn,
      refreshToken: token.refreshToken,
      scopes,
    },
  }
}

const persistConnection = async (
  session: AppSession,
  state: XeroOauthState,
  candidate: XeroConnectionCandidate,
  grant: PendingGrant,
  config: ConfiguredAccountingEnvironment,
): Promise<XeroConnection> => {
  const existing = await findConnection(session)
  if (existing?.tenantId && existing.tenantId !== candidate.tenantId) {
    throw new AccountingIntegrationError(
      'wrong-tenant',
      'The authorized Xero organisation does not match the pinned organisation.',
    )
  }

  const now = new Date().toISOString()
  const data = {
    accessTokenEnvelope: encryptSecret(
      grant.tokenSet.accessToken,
      ACCESS_TOKEN_PURPOSE,
      encryptionKey(config),
    ),
    accessTokenExpiresAt: new Date(Date.now() + grant.tokenSet.expiresIn * 1_000).toISOString(),
    authenticationEventId: grant.metadata.authenticationEventId,
    authorizedAt: now,
    authorizingXeroUserId: grant.metadata.xeroUserId,
    connectionId: candidate.connectionId,
    disconnectReason: null,
    disconnectedAt: null,
    disconnectedBy: null,
    grantedScopes: grant.metadata.scopes,
    initiatedBy: session.user.id,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastSuccessfulRequestAt: now,
    refreshLockExpiresAt: null,
    refreshLockId: null,
    refreshTokenEnvelope: encryptSecret(
      grant.tokenSet.refreshToken,
      REFRESH_TOKEN_PURPOSE,
      encryptionKey(config),
    ),
    singletonKey: CONNECTION_SINGLETON_KEY,
    status: 'connected' as const,
    tenantId: candidate.tenantId,
    tenantName: candidate.tenantName,
    tenantType: candidate.tenantType,
    tokenVersion: (existing?.tokenVersion ?? 0) + 1,
  }

  if (existing) {
    return session.payload.update({
      collection: 'xero-connections',
      id: existing.id,
      data,
      overrideAccess: true,
      req: session.req,
      showHiddenFields: true,
    })
  }

  return session.payload.create({
    collection: 'xero-connections',
    data,
    overrideAccess: true,
    req: session.req,
    showHiddenFields: true,
  })
}

const persistConnectionAndCompleteState = async (
  session: AppSession,
  state: XeroOauthState,
  candidate: XeroConnectionCandidate,
  grant: PendingGrant,
  config: ConfiguredAccountingEnvironment,
): Promise<XeroConnection> => {
  const connection = await commitConnectionAndState(session, state, candidate, grant, config)
  try {
    await resumeExportsAwaitingReconnect(session.payload)
  } catch {
    // Parked exports also recheck the connection on their own schedule.
  }
  return connection
}

const commitConnectionAndState = async (
  session: AppSession,
  state: XeroOauthState,
  candidate: XeroConnectionCandidate,
  grant: PendingGrant,
  config: ConfiguredAccountingEnvironment,
): Promise<XeroConnection> =>
  withPayloadTransaction(
    session.payload,
    async (req) => {
      const transactionSession: AppSession = { ...session, req }
      const previous = await findConnection(transactionSession)
      const connection = await persistConnection(
        transactionSession,
        state,
        candidate,
        grant,
        config,
      )
      await completeState(transactionSession, state.id, candidate.tenantId)
      const eventType =
        state.purpose === 'reconnect' ? 'xero.accounting-reconnected' : 'xero.accounting-connected'
      await recordAuditEvent(
        session.payload,
        {
          actor: session.user.id,
          eventType,
          metadata: {
            authorizingXeroUserId: grant.metadata.xeroUserId,
            connectionId: candidate.connectionId,
            previousAuthorizingXeroUserId: previous?.authorizingXeroUserId ?? undefined,
            tenantId: candidate.tenantId,
            tenantName: candidate.tenantName,
            credentialLineageVersion: connection.tokenVersion,
          },
          targetCollection: 'xero-connections',
          targetId: connection.id,
        },
        req,
      )
      return connection
    },
    { user: session.user },
  )

const verifyAccountingGrantCapability = async (
  client: XeroAccountingClient,
  accessToken: string,
  candidate: XeroConnectionCandidate,
): Promise<void> => {
  const organisationResponse = await client.accountingGet(
    accessToken,
    candidate.tenantId,
    'Organisation',
  )
  if (
    !isRecord(organisationResponse.data) ||
    !Array.isArray(organisationResponse.data.Organisations)
  ) {
    throw new AccountingIntegrationError(
      'invalid-organisation-response',
      'Xero did not return valid organisation capability data.',
    )
  }
  const organisation = organisationResponse.data.Organisations[0]
  if (!isRecord(organisation) || organisationResponse.data.Organisations.length !== 1) {
    throw new AccountingIntegrationError(
      'invalid-organisation-response',
      'Xero did not return valid organisation capability data.',
    )
  }
  if (typeof organisation.OrganisationID !== 'string') {
    throw new AccountingIntegrationError(
      'invalid-organisation-response',
      'Xero did not return valid organisation capability data.',
    )
  }
  if (organisation.OrganisationID !== candidate.tenantId) {
    throw new AccountingIntegrationError(
      'wrong-tenant',
      'The Xero organisation response does not match the pinned organisation.',
    )
  }

  const actionResponse = await client.accountingGet(
    accessToken,
    candidate.tenantId,
    'Organisation/Actions',
  )
  if (!isRecord(actionResponse.data) || !Array.isArray(actionResponse.data.Actions)) {
    throw new AccountingIntegrationError(
      'invalid-organisation-response',
      'Xero did not return valid organisation capability data.',
    )
  }
  const canCreateDraftInvoice = actionResponse.data.Actions.some(
    (action) =>
      isRecord(action) && action.Name === 'CreateDraftInvoice' && action.Status === 'ALLOWED',
  )
  if (!canCreateDraftInvoice) {
    throw new AccountingIntegrationError(
      'missing-create-draft-capability',
      'The selected Xero organisation cannot create draft invoices.',
    )
  }
}

const completeState = async (
  session: AppSession,
  stateID: string,
  tenantID: string,
): Promise<void> => {
  await session.payload.update({
    collection: 'xero-oauth-states',
    id: stateID,
    data: {
      completedAt: new Date().toISOString(),
      pendingConnections: null,
      pendingGrantEnvelope: null,
      selectedTenantId: tenantID,
      status: 'completed',
    },
    overrideAccess: true,
    req: session.req,
  })
}

export async function completeAccountingCallback(
  session: AppSession,
  input: { browserBinding: string; code: string; state: string },
  overrides: ServiceDependencies = {},
): Promise<{ flowID?: string; status: 'connected' | 'select-tenant' }> {
  if (
    input.state.length === 0 ||
    input.state.length > 500 ||
    input.code.length === 0 ||
    input.code.length > 5_000
  ) {
    throw new AccountingIntegrationError(
      'invalid-callback',
      'Xero returned an invalid accounting callback.',
    )
  }

  const found = validateBoundState(
    await findStateByHash(session, hashOpaqueValue(input.state)),
    session,
    input.browserBinding,
    'pending',
  )
  const state = await bulkClaimState(session, found.id, 'pending')
  const { client, config, validateAccessToken } = await dependencies(session, overrides)

  try {
    const tokenSet = await client.exchangeCode(input.code)
    const metadata = await validateAccessToken(tokenSet.accessToken, config)
    if (!grantsMatch(tokenSet.scopes, metadata.scopes)) {
      throw new AccountingIntegrationError(
        'scope-claim-mismatch',
        'The Xero token scope response did not match its signed claims.',
      )
    }

    let candidates = await client.listConnections(
      tokenSet.accessToken,
      metadata.authenticationEventId,
    )
    if (candidates.length === 0) {
      // Xero can retain the remote tenant connection when an earlier callback
      // fails. On the next authorization it shows the tenant as already
      // connected, so that tenant is not necessarily associated with the new
      // authentication event. The newly issued token is still the authority
      // boundary; recover its existing connections and retain the normal
      // pinned-tenant or explicit-selection checks below.
      candidates = await client.listConnections(tokenSet.accessToken)
    }
    if (candidates.length === 0) {
      throw new AccountingIntegrationError(
        'no-organisation',
        'No Xero organisation was authorized in this connection flow.',
      )
    }

    const grant: PendingGrant = { metadata, tokenSet }
    if (state.purpose === 'reconnect') {
      const candidate = candidates.find((item) => item.tenantId === state.pinnedTenantId)
      if (!candidate) {
        throw new AccountingIntegrationError(
          'wrong-tenant',
          'The authorized Xero organisation does not match the pinned organisation.',
        )
      }

      await verifyAccountingGrantCapability(client, tokenSet.accessToken, candidate)

      const previous = await findConnection(session)
      const previousRefreshToken = previous?.refreshTokenEnvelope
        ? decryptSecret(previous.refreshTokenEnvelope, REFRESH_TOKEN_PURPOSE, encryptionKey(config))
        : null
      await persistConnectionAndCompleteState(session, state, candidate, grant, config)
      if (previousRefreshToken && previousRefreshToken !== tokenSet.refreshToken) {
        try {
          await client.revokeRefreshToken(previousRefreshToken)
        } catch {
          // The newly validated grant remains active; remote cleanup can be checked separately.
        }
      }
      return { status: 'connected' }
    }

    if (candidates.length === 1) {
      const candidate = candidates[0]
      if (!candidate) {
        throw new AccountingIntegrationError(
          'no-organisation',
          'No Xero organisation was authorized.',
        )
      }
      await verifyAccountingGrantCapability(client, tokenSet.accessToken, candidate)
      await persistConnectionAndCompleteState(session, state, candidate, grant, config)
      return { status: 'connected' }
    }

    await session.payload.update({
      collection: 'xero-oauth-states',
      id: state.id,
      data: {
        expiresAt: new Date(Date.now() + ACCOUNTING_FLOW_MAX_AGE_SECONDS * 1_000).toISOString(),
        pendingConnections: candidates,
        pendingGrantEnvelope: encryptSecret(
          JSON.stringify(grant),
          PENDING_GRANT_PURPOSE,
          encryptionKey(config),
        ),
        status: 'awaiting-selection',
      },
      overrideAccess: true,
      req: session.req,
    })

    return { flowID: state.id, status: 'select-tenant' }
  } catch (error) {
    const code = error instanceof AccountingIntegrationError ? error.code : 'callback-failed'
    await markStateFailed(session, state.id, code)
    throw error
  }
}

export async function rejectAccountingCallback(
  session: AppSession,
  input: { browserBinding: string; failureCode: string; state: string },
): Promise<void> {
  if (input.state.length === 0 || input.state.length > 500) {
    throw new AccountingIntegrationError(
      'invalid-callback',
      'Xero returned an invalid accounting callback.',
    )
  }

  const found = validateBoundState(
    await findStateByHash(session, hashOpaqueValue(input.state)),
    session,
    input.browserBinding,
    'pending',
  )
  const state = await bulkClaimState(session, found.id, 'pending')
  await markStateFailed(session, state.id, input.failureCode)
}

const parsePendingConnections = (value: unknown): XeroConnectionCandidate[] =>
  parseConnectionsResponse(value)

const getSelectionState = async (
  session: AppSession,
  flowID: string,
  browserBinding: string,
): Promise<XeroOauthState> => {
  if (flowID.length === 0 || flowID.length > 100) {
    throw new AccountingIntegrationError('invalid-state', 'The tenant selection is invalid.')
  }

  let state: XeroOauthState | null = null
  try {
    state = await session.payload.findByID({
      collection: 'xero-oauth-states',
      depth: 0,
      id: flowID,
      overrideAccess: true,
      req: session.req,
      showHiddenFields: true,
    })
  } catch {
    // A missing or malformed ID has the same safe result as an expired flow.
  }

  return validateBoundState(state, session, browserBinding, 'awaiting-selection')
}

export async function getAccountingTenantSelection(
  session: AppSession,
  flowID: string,
  browserBinding: string,
): Promise<TenantSelection> {
  const state = await getSelectionState(session, flowID, browserBinding)
  return { connections: parsePendingConnections(state.pendingConnections), flowID: state.id }
}

export async function selectAccountingTenant(
  session: AppSession,
  input: { browserBinding: string; flowID: string; tenantID: string },
  overrides: Pick<ServiceDependencies, 'client' | 'config'> = {},
): Promise<void> {
  const found = await getSelectionState(session, input.flowID, input.browserBinding)
  const state = await bulkClaimState(session, found.id, 'awaiting-selection')
  const candidates = parsePendingConnections(found.pendingConnections)
  const candidate = candidates.find((item) => item.tenantId === input.tenantID)

  if (!candidate || !found.pendingGrantEnvelope) {
    await markStateFailed(session, found.id, 'invalid-tenant-selection')
    throw new AccountingIntegrationError(
      'invalid-tenant-selection',
      'Select one of the Xero organisations returned by this authorization.',
    )
  }

  try {
    const { client, config } = await dependencies(session, overrides)
    const grant = parsePendingGrant(found.pendingGrantEnvelope, config)
    await verifyAccountingGrantCapability(client, grant.tokenSet.accessToken, candidate)
    await persistConnectionAndCompleteState(session, state, candidate, grant, config)
  } catch (error) {
    const code = error instanceof AccountingIntegrationError ? error.code : 'selection-failed'
    await markStateFailed(session, state.id, code)
    throw error
  }
}

const acquireRefreshLock = async (
  session: AppSession,
  connection: XeroConnection,
  lockID: string,
): Promise<boolean> => {
  const result = await requireMongoModel(session.payload, 'xero-connections').findOneAndUpdate(
    {
      _id: connection.id,
      $or: [
        { refreshLockId: { $exists: false } },
        { refreshLockId: null },
        { refreshLockExpiresAt: { $lt: new Date() } },
      ],
      status: 'connected',
      tokenVersion: connection.tokenVersion,
    },
    {
      $set: {
        refreshLockExpiresAt: new Date(Date.now() + 30_000),
        refreshLockId: lockID,
      },
    },
    { new: true },
  )
  return Boolean(result)
}

const updateRefreshFailure = async (
  session: AppSession,
  connection: XeroConnection,
  lockID: string,
  error: AccountingIntegrationError,
): Promise<void> => {
  const terminal = !error.retryable
  await requireMongoModel(session.payload, 'xero-connections').findOneAndUpdate(
    { _id: connection.id, refreshLockId: lockID },
    {
      $set: {
        accessTokenEnvelope: terminal ? null : connection.accessTokenEnvelope,
        accessTokenExpiresAt: terminal
          ? null
          : connection.accessTokenExpiresAt
            ? new Date(connection.accessTokenExpiresAt)
            : null,
        lastErrorCode: error.code.slice(0, 100),
        lastErrorMessage: terminal
          ? connectionFailureMessage(error.code)
          : 'The Xero token refresh did not complete and can be retried.',
        refreshLockExpiresAt: null,
        refreshLockId: null,
        refreshTokenEnvelope: terminal ? null : connection.refreshTokenEnvelope,
        status: terminal ? 'action-required' : 'connected',
      },
    },
    { new: true },
  )
}

const waitForConcurrentRefresh = async (
  session: AppSession,
  previousVersion: number,
): Promise<XeroConnection> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const current = await findConnection(session)
    if (!current) break
    if (current.tokenVersion > previousVersion || current.status !== 'connected') return current
  }

  throw new AccountingIntegrationError(
    'refresh-in-progress',
    'Another Xero token refresh is still in progress.',
    { retryable: true },
  )
}

export async function getValidAccountingAccessToken(
  session: AppSession,
  overrides: ServiceDependencies = {},
): Promise<{ accessToken: string; connection: XeroConnection }> {
  let connection = await findConnection(session)

  // Check the connection first so a broken connection is reported as needing a reconnect even
  // when its application credentials are also unusable.
  if (
    !connection ||
    connection.status !== 'connected' ||
    !connection.accessTokenEnvelope ||
    !connection.refreshTokenEnvelope ||
    !connection.accessTokenExpiresAt
  ) {
    throw connection?.status === 'action-required'
      ? new AccountingIntegrationError(
          'reconnect-required',
          'Xero needs to be reconnected before this can continue.',
          { reconnectRequired: true },
        )
      : new AccountingIntegrationError(
          'not-connected',
          'The Xero accounting organisation is not connected.',
          { reconnectRequired: true },
        )
  }
  const resolved = await dependencies(session, overrides)

  if (new Date(connection.accessTokenExpiresAt).getTime() > Date.now() + ACCESS_REFRESH_SKEW_MS) {
    return {
      accessToken: decryptSecret(
        connection.accessTokenEnvelope,
        ACCESS_TOKEN_PURPOSE,
        encryptionKey(resolved.config),
      ),
      connection,
    }
  }

  const lockID = randomOpaqueValue()
  if (!(await acquireRefreshLock(session, connection, lockID))) {
    connection = await waitForConcurrentRefresh(session, connection.tokenVersion)
    if (connection.status === 'action-required') {
      throw new AccountingIntegrationError(
        'reconnect-required',
        'Xero needs to be reconnected before this can continue.',
        { reconnectRequired: true },
      )
    }
    if (
      connection.status !== 'connected' ||
      !connection.accessTokenEnvelope ||
      !connection.accessTokenExpiresAt ||
      new Date(connection.accessTokenExpiresAt).getTime() <= Date.now()
    ) {
      throw new AccountingIntegrationError(
        'refresh-failed',
        'The Xero accounting token refresh did not complete.',
        { retryable: true },
      )
    }
    return {
      accessToken: decryptSecret(
        connection.accessTokenEnvelope,
        ACCESS_TOKEN_PURPOSE,
        encryptionKey(resolved.config),
      ),
      connection,
    }
  }

  try {
    const refreshToken = decryptSecret(
      connection.refreshTokenEnvelope,
      REFRESH_TOKEN_PURPOSE,
      encryptionKey(resolved.config),
    )
    const tokenSet = await resolved.client.refreshTokens(refreshToken)
    const metadata = await resolved.validateAccessToken(tokenSet.accessToken, resolved.config)
    if (
      !grantsMatch(tokenSet.scopes, metadata.scopes) ||
      (connection.authorizingXeroUserId && connection.authorizingXeroUserId !== metadata.xeroUserId)
    ) {
      throw new AccountingIntegrationError(
        'refresh-identity-mismatch',
        'The refreshed Xero token did not match the stored accounting grant.',
      )
    }

    const now = new Date().toISOString()
    const updated = await requireMongoModel(session.payload, 'xero-connections').findOneAndUpdate(
      { _id: connection.id, refreshLockId: lockID },
      {
        $set: {
          accessTokenEnvelope: encryptSecret(
            tokenSet.accessToken,
            ACCESS_TOKEN_PURPOSE,
            encryptionKey(resolved.config),
          ),
          accessTokenExpiresAt: new Date(Date.now() + tokenSet.expiresIn * 1_000),
          authenticationEventId: metadata.authenticationEventId,
          grantedScopes: metadata.scopes,
          lastErrorCode: null,
          lastErrorMessage: null,
          lastRefreshedAt: now,
          refreshLockExpiresAt: null,
          refreshLockId: null,
          refreshTokenEnvelope: encryptSecret(
            tokenSet.refreshToken,
            REFRESH_TOKEN_PURPOSE,
            encryptionKey(resolved.config),
          ),
          tokenVersion: connection.tokenVersion + 1,
        },
      },
      { new: true },
    )
    if (!updated) {
      throw new AccountingIntegrationError(
        'refresh-lock-lost',
        'The Xero token refresh lock was lost.',
        { retryable: true },
      )
    }

    const refreshed = await findConnection(session)
    if (!refreshed) {
      throw new AccountingIntegrationError(
        'refresh-persistence-failed',
        'The refreshed Xero token could not be reloaded.',
        { retryable: true },
      )
    }

    return { accessToken: tokenSet.accessToken, connection: refreshed }
  } catch (error) {
    const safeError =
      error instanceof AccountingIntegrationError
        ? error
        : new AccountingIntegrationError('token-refresh-failed', 'The Xero token refresh failed.', {
            cause: error,
            retryable: true,
          })
    await updateRefreshFailure(session, connection, lockID, safeError)
    if (!safeError.retryable) safeError.reconnectRequired = true
    throw safeError
  }
}

export async function checkAccountingConnectionHealth(
  session: AppSession,
  overrides: ServiceDependencies = {},
): Promise<AccountingConnectionView> {
  const resolved = await dependencies(session, overrides)
  const { accessToken, connection } = await getValidAccountingAccessToken(session, resolved)
  const candidates = await resolved.client.listConnections(accessToken)
  const current = candidates.find(
    (candidate) =>
      candidate.tenantId === connection.tenantId &&
      candidate.connectionId === connection.connectionId,
  )
  const now = new Date().toISOString()

  if (!current) {
    const updated = await session.payload.update({
      collection: 'xero-connections',
      id: connection.id,
      data: {
        lastErrorCode: 'connection-missing',
        lastErrorMessage: 'The pinned Xero organisation is no longer connected.',
        lastHealthCheckAt: now,
        status: 'action-required',
      },
      overrideAccess: true,
      req: session.req,
    })
    return safeConnectionView(updated)
  }

  const updated = await session.payload.update({
    collection: 'xero-connections',
    id: connection.id,
    data: {
      lastErrorCode: null,
      lastErrorMessage: null,
      lastHealthCheckAt: now,
      lastSuccessfulRequestAt: now,
      tenantName: current.tenantName,
    },
    overrideAccess: true,
    req: session.req,
  })
  return safeConnectionView(updated)
}

export async function disconnectAccountingConnection(
  session: AppSession,
  reason: string = '',
  overrides: ServiceDependencies = {},
): Promise<{ remoteCleanupComplete: boolean }> {
  const normalizedReason = reason.trim().slice(0, 1_000) || 'Disconnected from settings.'

  const resolved = await dependencies(session, overrides)
  let connection = await findConnection(session)
  if (!connection || connection.status === 'disconnected') {
    throw new AccountingIntegrationError(
      'not-connected',
      'The Xero accounting organisation is not connected.',
    )
  }

  const unsafeExports = await session.payload.find({
    collection: 'invoice-exports',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req: session.req,
    where: {
      state: {
        in: [
          'preparing',
          'queued',
          'processing',
          'retry-wait',
          'action-required',
          'reconciling',
          'manual-review',
        ],
      },
    },
  })
  if (unsafeExports.docs[0]) {
    throw new AccountingIntegrationError(
      'unsafe-export-state',
      'Resolve or safely cancel every non-terminal export before disconnecting Xero accounting.',
    )
  }

  let accessToken: string | null = null
  try {
    accessToken = (await getValidAccountingAccessToken(session, resolved)).accessToken
    connection = (await findConnection(session)) ?? connection
  } catch {
    if (connection.accessTokenEnvelope) {
      try {
        accessToken = decryptSecret(
          connection.accessTokenEnvelope,
          ACCESS_TOKEN_PURPOSE,
          encryptionKey(resolved.config),
        )
      } catch {
        accessToken = null
      }
    }
  }

  let refreshToken: string | null = null
  if (connection.refreshTokenEnvelope) {
    try {
      refreshToken = decryptSecret(
        connection.refreshTokenEnvelope,
        REFRESH_TOKEN_PURPOSE,
        encryptionKey(resolved.config),
      )
    } catch {
      refreshToken = null
    }
  }

  let remoteDeleted = false
  let revoked = false
  if (accessToken && connection.connectionId) {
    try {
      await resolved.client.deleteConnection(accessToken, connection.connectionId)
      remoteDeleted = true
    } catch {
      // Local access is still removed; the UI reports incomplete remote cleanup.
    }
  }
  if (refreshToken) {
    try {
      await resolved.client.revokeRefreshToken(refreshToken)
      revoked = true
    } catch {
      // Local access is still removed; the UI reports incomplete remote cleanup.
    }
  }

  const remoteDeleteRequired = Boolean(accessToken && connection.connectionId)
  const tokenRevocationRequired = Boolean(refreshToken)
  const remoteCleanupComplete =
    (remoteDeleteRequired || tokenRevocationRequired) &&
    (!remoteDeleteRequired || remoteDeleted) &&
    (!tokenRevocationRequired || revoked)
  await session.payload.update({
    collection: 'xero-connections',
    id: connection.id,
    data: {
      accessTokenEnvelope: null,
      accessTokenExpiresAt: null,
      disconnectReason: normalizedReason,
      disconnectedAt: new Date().toISOString(),
      disconnectedBy: session.user.id,
      lastErrorCode: remoteCleanupComplete ? null : 'remote-disconnect-incomplete',
      lastErrorMessage: remoteCleanupComplete
        ? null
        : 'Local credentials were removed, but Xero may still list the connected app.',
      refreshLockExpiresAt: null,
      refreshLockId: null,
      refreshTokenEnvelope: null,
      status: 'disconnected',
      tokenVersion: connection.tokenVersion + 1,
    },
    overrideAccess: true,
    req: session.req,
  })
  await recordAuditEvent(
    session.payload,
    {
      actor: session.user.id,
      eventType: 'xero.accounting-disconnected',
      metadata: { remoteCleanupComplete },
      reason: normalizedReason,
      targetCollection: 'xero-connections',
      targetId: connection.id,
    },
    session.req,
  )

  return { remoteCleanupComplete }
}
