import { describe, expect, it, vi } from 'vitest'

import { createXeroAccountingClient } from '@/lib/xero/accounting/client'
import {
  AccountingIntegrationError,
  REQUIRED_ACCOUNTING_SCOPES,
  parseConnectionsResponse,
  parseTokenResponse,
  validateAccountingScopes,
} from '@/lib/xero/accounting/contracts'
import {
  decryptSecret,
  deriveEncryptionKey,
  encryptSecret,
  hashOpaqueValue,
  opaqueHashMatches,
} from '@/lib/xero/accounting/crypto'
import { validateAccountingTokenClaims } from '@/lib/xero/accounting/token'

import type { JWTPayload } from 'jose'

const key = { keyHex: '11'.repeat(32), version: 7 }
const clientConfig = {
  clientID: 'accounting-client-id',
  clientSecret: 'accounting-client-secret',
  configured: true,
  redirectURI: 'http://localhost:3000/api/integrations/xero/accounting/callback',
  tokenEncryptionKey: key.keyHex,
  tokenEncryptionKeyVersion: key.version,
} as const

const tokenResponse = {
  access_token: 'access-token',
  expires_in: 1_800,
  refresh_token: 'refresh-token',
  scope: REQUIRED_ACCOUNTING_SCOPES.join(' '),
  token_type: 'Bearer',
}

const connectionResponse = [
  {
    authEventId: '11111111-1111-4111-8111-111111111111',
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: '33333333-3333-4333-8333-333333333333',
    tenantName: 'Demo Company',
    tenantType: 'ORGANISATION',
  },
]
const connectionFixture = connectionResponse[0]!

describe('Xero accounting security primitives', () => {
  it('derives deterministic, purpose-separated keys from the deployment root secret', () => {
    const configurationKey = deriveEncryptionKey(
      'deployment-root-secret-for-tests',
      'configuration',
    )
    const tokenKey = deriveEncryptionKey('deployment-root-secret-for-tests', 'tokens')

    expect(configurationKey).toEqual(
      deriveEncryptionKey('deployment-root-secret-for-tests', 'configuration'),
    )
    expect(configurationKey.keyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(configurationKey.keyHex).not.toBe(tokenKey.keyHex)
  })

  it('encrypts with authenticated purpose binding and detects tampering', () => {
    const envelope = encryptSecret('sensitive-refresh-token', 'refresh', key)

    expect(envelope).not.toContain('sensitive-refresh-token')
    expect(decryptSecret(envelope, 'refresh', key)).toBe('sensitive-refresh-token')
    expect(() => decryptSecret(envelope, 'access', key)).toThrow(AccountingIntegrationError)
    const tamperedSegments = envelope.split('.')
    const ciphertext = tamperedSegments[2]!
    tamperedSegments[2] = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`
    expect(() => decryptSecret(tamperedSegments.join('.'), 'refresh', key)).toThrow(
      AccountingIntegrationError,
    )
  })

  it('hashes opaque browser/state values and compares them safely', () => {
    const hash = hashOpaqueValue('opaque-value')

    expect(hash).not.toContain('opaque-value')
    expect(opaqueHashMatches('opaque-value', hash)).toBe(true)
    expect(opaqueHashMatches('different-value', hash)).toBe(false)
  })

  it('accepts exactly the accounting scopes and rejects identity or expanded scopes', () => {
    expect(validateAccountingScopes(REQUIRED_ACCOUNTING_SCOPES)).toEqual(REQUIRED_ACCOUNTING_SCOPES)
    expect(() =>
      validateAccountingScopes(
        REQUIRED_ACCOUNTING_SCOPES.filter((scope) => scope !== 'offline_access'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-scopes' }))
    expect(() => validateAccountingScopes([...REQUIRED_ACCOUNTING_SCOPES, 'openid'])).toThrowError(
      expect.objectContaining({ code: 'identity-scope-rejected' }),
    )
    expect(() =>
      validateAccountingScopes([...REQUIRED_ACCOUNTING_SCOPES, 'accounting.payments']),
    ).toThrowError(expect.objectContaining({ code: 'invalid-scopes' }))
  })

  it('validates token responses and refuses an unexpected identity token', () => {
    expect(parseTokenResponse(tokenResponse)).toMatchObject({
      accessToken: 'access-token',
      expiresIn: 1_800,
      refreshToken: 'refresh-token',
      scopes: REQUIRED_ACCOUNTING_SCOPES,
    })
    expect(() => parseTokenResponse({ ...tokenResponse, id_token: 'not-allowed' })).toThrowError(
      expect.objectContaining({ code: 'identity-token-rejected' }),
    )
  })

  it('validates organisation connections and rejects non-accounting tenants', () => {
    expect(parseConnectionsResponse(connectionResponse)).toEqual([
      {
        authEventId: connectionFixture.authEventId,
        connectionId: connectionFixture.id,
        tenantId: connectionFixture.tenantId,
        tenantName: 'Demo Company',
        tenantType: 'ORGANISATION',
      },
    ])
    expect(() =>
      parseConnectionsResponse([{ ...connectionFixture, tenantType: 'PRACTICE' }]),
    ).toThrowError(expect.objectContaining({ code: 'invalid-connections-response' }))
  })

  it('requires accounting access-token claims for the configured client', () => {
    const claims: JWTPayload = {
      authentication_event_id: connectionFixture.authEventId,
      client_id: clientConfig.clientID,
      iss: 'https://identity.xero.com',
      scope: [...REQUIRED_ACCOUNTING_SCOPES],
      xero_userid: '44444444-4444-4444-8444-444444444444',
    }

    expect(validateAccountingTokenClaims(claims, clientConfig.clientID)).toMatchObject({
      authenticationEventId: connectionFixture.authEventId,
      scopes: REQUIRED_ACCOUNTING_SCOPES,
      xeroUserId: '44444444-4444-4444-8444-444444444444',
    })
    expect(() => validateAccountingTokenClaims(claims, 'different-client')).toThrowError(
      expect.objectContaining({ code: 'invalid-token-client' }),
    )
  })
})

describe('Xero accounting HTTP client', () => {
  it('uses the standard code exchange and filters connections by auth event', async () => {
    const requests: Array<{ body: string; headers: Headers; method: string; url: string }> = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      requests.push({
        body: String(init?.body ?? ''),
        headers: new Headers(init?.headers),
        method: init?.method ?? 'GET',
        url,
      })

      return url.includes('/connections')
        ? new Response(
            JSON.stringify([
              ...connectionResponse,
              {
                authEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                tenantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                tenantName: 'Different authorization event',
                tenantType: 'ORGANISATION',
              },
            ]),
            { status: 200 },
          )
        : new Response(JSON.stringify(tokenResponse), { status: 200 })
    })
    const client = createXeroAccountingClient(clientConfig, fetchMock)

    await expect(client.exchangeCode('one-time-code')).resolves.toMatchObject({
      accessToken: 'access-token',
    })
    await expect(
      client.listConnections('access-token', connectionFixture.authEventId),
    ).resolves.toHaveLength(1)

    const tokenRequest = requests[0]!
    const connectionsRequest = requests[1]!
    expect(tokenRequest).toMatchObject({
      method: 'POST',
      url: 'https://identity.xero.com/connect/token',
    })
    expect(tokenRequest.body).toContain('grant_type=authorization_code')
    expect(tokenRequest.body).toContain('code=one-time-code')
    expect(tokenRequest.body).not.toContain('openid')
    expect(tokenRequest.headers.get('authorization')).toMatch(/^Basic /)
    expect(connectionsRequest.url).toContain(`authEventId=${connectionFixture.authEventId}`)
    expect(connectionsRequest.headers.get('authorization')).toBe('Bearer access-token')
  })

  it('returns only safe provider error metadata', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'secret provider detail that must not escape',
          }),
          { status: 400 },
        ),
    )
    const client = createXeroAccountingClient(clientConfig, fetchMock)

    await expect(client.refreshTokens('old-refresh-token')).rejects.toMatchObject({
      code: 'token-refresh-invalid-grant',
      message: 'Xero rejected the accounting request.',
      status: 400,
    })
  })
})
