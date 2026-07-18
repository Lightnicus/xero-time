import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

import {
  AccountingIntegrationError,
  validateAccountingScopes,
  type AccountingScope,
  type XeroAccountingRuntimeConfig,
} from './contracts'

const XERO_ISSUER = 'https://identity.xero.com'
const XERO_RESOURCE_AUDIENCE = 'https://identity.xero.com/resources'
const xeroJWKS = createRemoteJWKSet(
  new URL('https://identity.xero.com/.well-known/openid-configuration/jwks'),
)

export type AccountingAccessTokenMetadata = {
  authenticationEventId: string
  scopes: AccountingScope[]
  xeroUserId: string
}

const requiredStringClaim = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) {
    throw new AccountingIntegrationError(code, 'Xero returned an invalid accounting access token.')
  }
  return value
}

export function validateAccountingTokenClaims(
  payload: JWTPayload,
  clientID: string,
): AccountingAccessTokenMetadata {
  if (payload.iss !== XERO_ISSUER || payload.client_id !== clientID) {
    throw new AccountingIntegrationError(
      'invalid-token-client',
      'The Xero accounting token was issued for a different client.',
    )
  }

  return {
    authenticationEventId: requiredStringClaim(
      payload.authentication_event_id,
      'missing-authentication-event',
    ),
    scopes: validateAccountingScopes(payload.scope),
    xeroUserId: requiredStringClaim(payload.xero_userid, 'missing-xero-user'),
  }
}

export async function validateAccountingAccessToken(
  accessToken: string,
  config: XeroAccountingRuntimeConfig,
): Promise<AccountingAccessTokenMetadata> {
  try {
    const { payload } = await jwtVerify(accessToken, xeroJWKS, {
      audience: [XERO_RESOURCE_AUDIENCE, config.clientID],
      issuer: XERO_ISSUER,
    })

    return validateAccountingTokenClaims(payload, config.clientID)
  } catch (error) {
    if (error instanceof AccountingIntegrationError) throw error
    throw new AccountingIntegrationError(
      'invalid-access-token',
      'The Xero accounting access token could not be verified.',
      { cause: error },
    )
  }
}
