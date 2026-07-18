import {
  AccountingIntegrationError,
  parseConnectionsResponse,
  parseTokenResponse,
  type XeroAccountingRuntimeConfig,
  type XeroConnectionCandidate,
  type XeroTokenSet,
} from './contracts'

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_REVOCATION_URL = 'https://identity.xero.com/connect/revocation'
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'
const XERO_ACCOUNTING_API_URL = 'https://api.xero.com/api.xro/2.0/'

export type XeroAPIResponse = {
  correlationID?: string
  data: unknown
  rateLimitRemaining?: number
}

export type XeroAccountingClient = {
  accountingGet(
    accessToken: string,
    tenantID: string,
    path: string,
    parameters?: Record<string, string>,
  ): Promise<XeroAPIResponse>
  accountingPost(
    accessToken: string,
    tenantID: string,
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<XeroAPIResponse>
  deleteConnection(accessToken: string, connectionID: string): Promise<void>
  exchangeCode(code: string): Promise<XeroTokenSet>
  listConnections(
    accessToken: string,
    authenticationEventID?: string,
  ): Promise<XeroConnectionCandidate[]>
  refreshTokens(refreshToken: string): Promise<XeroTokenSet>
  revokeRefreshToken(refreshToken: string): Promise<void>
}

const safeProviderCode = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(value) ? value : null

export function createXeroAccountingClient(
  config: XeroAccountingRuntimeConfig,
  fetchImplementation: typeof fetch = fetch,
): XeroAccountingClient {
  const basicAuthorization = `Basic ${Buffer.from(`${config.clientID}:${config.clientSecret}`, 'utf8').toString('base64')}`

  const request = async (operation: string, url: string, init: RequestInit): Promise<Response> => {
    let response: Response

    try {
      response = await fetchImplementation(url, {
        ...init,
        cache: 'no-store',
        signal: init.signal ?? AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new AccountingIntegrationError(
        `${operation}-network-error`,
        'Xero could not be reached. The operation can be retried safely.',
        {
          cause: error,
          requestMayHaveBeenSent: init.method === 'POST',
          retryable: true,
        },
      )
    }

    if (response.ok) return response

    let providerCode: string | null = null
    try {
      const body = (await response.clone().json()) as { error?: unknown }
      providerCode = safeProviderCode(body.error)
    } catch {
      // Provider response bodies are intentionally not surfaced or logged.
    }

    const correlationID = safeProviderCode(response.headers.get('xero-correlation-id')) ?? undefined
    const rateLimitRemaining = Number(response.headers.get('x-rate-limit-remaining'))
    const retryAfterSeconds = Number(response.headers.get('retry-after'))
    throw new AccountingIntegrationError(
      providerCode ? `${operation}-${providerCode}` : `${operation}-http-${response.status}`,
      'Xero rejected the accounting request.',
      {
        correlationID,
        rateLimitRemaining: Number.isFinite(rateLimitRemaining) ? rateLimitRemaining : undefined,
        requestMayHaveBeenSent: init.method === 'POST' && response.status >= 500,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
      },
    )
  }

  const tokenRequest = async (body: URLSearchParams, operation: string): Promise<XeroTokenSet> => {
    const response = await request(operation, XERO_TOKEN_URL, {
      body,
      headers: {
        Accept: 'application/json',
        Authorization: basicAuthorization,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    })

    return parseTokenResponse(await response.json())
  }

  return {
    async accountingGet(accessToken, tenantID, path, parameters = {}) {
      if (!/^[A-Za-z][A-Za-z0-9/-]{0,100}$/.test(path)) {
        throw new AccountingIntegrationError('invalid-api-path', 'The Xero API path is invalid.')
      }
      const url = new URL(path, XERO_ACCOUNTING_API_URL)
      for (const [key, value] of Object.entries(parameters)) {
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(key) && value.length <= 1_000) {
          url.searchParams.set(key, value)
        }
      }
      const response = await request('accounting-get', url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'xero-tenant-id': tenantID,
        },
        method: 'GET',
      })
      const remaining = Number(response.headers.get('x-rate-limit-remaining'))
      return {
        correlationID: response.headers.get('xero-correlation-id') ?? undefined,
        data: await response.json(),
        rateLimitRemaining: Number.isFinite(remaining) ? remaining : undefined,
      }
    },

    async accountingPost(accessToken, tenantID, path, body, idempotencyKey) {
      if (
        !/^[A-Za-z][A-Za-z0-9/-]{0,100}$/.test(path) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)
      ) {
        throw new AccountingIntegrationError(
          'invalid-accounting-request',
          'The Xero accounting request is invalid.',
        )
      }
      const response = await request(
        'accounting-post',
        new URL(path, XERO_ACCOUNTING_API_URL).toString(),
        {
          body: JSON.stringify(body),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            'xero-tenant-id': tenantID,
          },
          method: 'POST',
        },
      )
      const remaining = Number(response.headers.get('x-rate-limit-remaining'))
      return {
        correlationID: response.headers.get('xero-correlation-id') ?? undefined,
        data: await response.json(),
        rateLimitRemaining: Number.isFinite(remaining) ? remaining : undefined,
      }
    },

    async deleteConnection(accessToken, connectionID) {
      await request('disconnect', `${XERO_CONNECTIONS_URL}/${encodeURIComponent(connectionID)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        method: 'DELETE',
      })
    },

    exchangeCode(code) {
      return tokenRequest(
        new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          redirect_uri: config.redirectURI,
        }),
        'code-exchange',
      )
    },

    async listConnections(accessToken, authenticationEventID) {
      const url = new URL(XERO_CONNECTIONS_URL)
      if (authenticationEventID) url.searchParams.set('authEventId', authenticationEventID)
      const response = await request('list-connections', url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        method: 'GET',
      })

      const connections = parseConnectionsResponse(await response.json())
      return authenticationEventID
        ? connections.filter((connection) => connection.authEventId === authenticationEventID)
        : connections
    },

    refreshTokens(refreshToken) {
      return tokenRequest(
        new URLSearchParams({
          client_id: config.clientID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
        'token-refresh',
      )
    },

    async revokeRefreshToken(refreshToken) {
      await request('token-revocation', XERO_REVOCATION_URL, {
        body: new URLSearchParams({ token: refreshToken }),
        headers: {
          Authorization: basicAuthorization,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      })
    },
  }
}
