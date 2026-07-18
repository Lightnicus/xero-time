export const REQUIRED_ACCOUNTING_SCOPES = [
  'offline_access',
  'accounting.invoices',
  'accounting.contacts',
  'accounting.settings.read',
] as const

export type AccountingScope = (typeof REQUIRED_ACCOUNTING_SCOPES)[number]

export type XeroAccountingRuntimeConfig = {
  clientID: string
  clientSecret: string
  configured: true
  redirectURI: string
  tokenEncryptionKey: string
  tokenEncryptionKeyVersion: number
}

const forbiddenIdentityScopes = new Set(['openid', 'profile', 'email'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class AccountingIntegrationError extends Error {
  correlationID?: string
  code: string
  rateLimitRemaining?: number
  requestMayHaveBeenSent: boolean
  retryAfterSeconds?: number
  retryable: boolean
  status?: number

  constructor(
    code: string,
    message: string,
    options: {
      cause?: unknown
      correlationID?: string
      rateLimitRemaining?: number
      requestMayHaveBeenSent?: boolean
      retryAfterSeconds?: number
      retryable?: boolean
      status?: number
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'AccountingIntegrationError'
    this.code = code
    this.correlationID = options.correlationID
    this.rateLimitRemaining = options.rateLimitRemaining
    this.requestMayHaveBeenSent = options.requestMayHaveBeenSent ?? false
    this.retryAfterSeconds = options.retryAfterSeconds
    this.retryable = options.retryable ?? false
    this.status = options.status
  }
}

export type XeroTokenSet = {
  accessToken: string
  expiresIn: number
  refreshToken: string
  scopes: AccountingScope[]
}

export type XeroConnectionCandidate = {
  authEventId: string
  connectionId: string
  tenantId: string
  tenantName: string
  tenantType: 'ORGANISATION'
}

const normalizeScopeInput = (value: unknown): string[] | null => {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  return null
}

export function validateAccountingScopes(value: unknown): AccountingScope[] {
  const values = normalizeScopeInput(value)
  if (!values || values.length === 0) {
    throw new AccountingIntegrationError(
      'invalid-scopes',
      'Xero did not return the expected accounting permissions.',
    )
  }

  const uniqueValues = new Set(values)
  if ([...uniqueValues].some((scope) => forbiddenIdentityScopes.has(scope))) {
    throw new AccountingIntegrationError(
      'identity-scope-rejected',
      'The accounting authorization unexpectedly included identity permissions.',
    )
  }

  if (
    uniqueValues.size !== REQUIRED_ACCOUNTING_SCOPES.length ||
    REQUIRED_ACCOUNTING_SCOPES.some((scope) => !uniqueValues.has(scope))
  ) {
    throw new AccountingIntegrationError(
      'invalid-scopes',
      'Xero did not grant exactly the required accounting permissions.',
    )
  }

  return [...REQUIRED_ACCOUNTING_SCOPES]
}

export function parseTokenResponse(value: unknown): XeroTokenSet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountingIntegrationError('invalid-token-response', 'Xero returned invalid tokens.')
  }

  const token = value as Record<string, unknown>
  if (Object.hasOwn(token, 'id_token')) {
    throw new AccountingIntegrationError(
      'identity-token-rejected',
      'The accounting authorization unexpectedly returned an identity token.',
    )
  }

  const accessToken = token.access_token
  const refreshToken = token.refresh_token
  const expiresIn = token.expires_in
  const tokenType = token.token_type

  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    accessToken.length > 50_000 ||
    typeof refreshToken !== 'string' ||
    refreshToken.length === 0 ||
    refreshToken.length > 50_000 ||
    typeof expiresIn !== 'number' ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn < 60 ||
    expiresIn > 3_600 ||
    (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer')
  ) {
    throw new AccountingIntegrationError('invalid-token-response', 'Xero returned invalid tokens.')
  }

  return {
    accessToken,
    expiresIn,
    refreshToken,
    scopes: validateAccountingScopes(token.scope),
  }
}

export function parseConnectionsResponse(value: unknown): XeroConnectionCandidate[] {
  if (!Array.isArray(value)) {
    throw new AccountingIntegrationError(
      'invalid-connections-response',
      'Xero returned an invalid organisation list.',
    )
  }

  const connections = value.map((candidate): XeroConnectionCandidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new AccountingIntegrationError(
        'invalid-connections-response',
        'Xero returned an invalid organisation.',
      )
    }

    const item = candidate as Record<string, unknown>
    const connectionID = typeof item.id === 'string' ? item.id : item.connectionId
    if (
      typeof connectionID !== 'string' ||
      !uuidPattern.test(connectionID) ||
      typeof item.authEventId !== 'string' ||
      !uuidPattern.test(item.authEventId) ||
      typeof item.tenantId !== 'string' ||
      !uuidPattern.test(item.tenantId) ||
      item.tenantType !== 'ORGANISATION' ||
      typeof item.tenantName !== 'string' ||
      item.tenantName.trim().length === 0 ||
      item.tenantName.length > 255
    ) {
      throw new AccountingIntegrationError(
        'invalid-connections-response',
        'Xero returned an invalid organisation.',
      )
    }

    return {
      authEventId: item.authEventId,
      connectionId: connectionID,
      tenantId: item.tenantId,
      tenantName: item.tenantName.trim(),
      tenantType: 'ORGANISATION',
    }
  })

  const tenantIDs = new Set(connections.map((connection) => connection.tenantId))
  if (tenantIDs.size !== connections.length) {
    throw new AccountingIntegrationError(
      'duplicate-tenant',
      'Xero returned the same organisation more than once.',
    )
  }

  return connections
}
