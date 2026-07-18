import * as oidc from 'openid-client'

import type { XeroIdentityEnvironment } from '@/lib/env'

import {
  IdentityIntegrationError,
  REQUIRED_IDENTITY_SCOPES,
  XERO_IDENTITY_ISSUER,
  validateIdentityScopes,
  type XeroIdentityClaims,
} from './contracts'

type ConfiguredIdentityEnvironment = Extract<XeroIdentityEnvironment, { configured: true }>

export type IdentityAuthorizationInput = {
  nonce: string
  pkceChallenge: string
  state: string
}

export type IdentityCallbackInput = {
  callbackURL: URL
  expectedNonce: string
  expectedState: string
  pkceVerifier: string
}

export type XeroIdentityClient = {
  authorizationURL(input: IdentityAuthorizationInput): Promise<string>
  exchangeCallback(input: IdentityCallbackInput): Promise<XeroIdentityClaims>
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const safeString = (value: unknown, maxLength: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : null

export function createXeroIdentityClient(
  environment: ConfiguredIdentityEnvironment,
): XeroIdentityClient {
  let configuration: Promise<oidc.Configuration> | null = null
  const getConfiguration = (): Promise<oidc.Configuration> => {
    configuration ??= oidc.discovery(
      new URL(XERO_IDENTITY_ISSUER),
      environment.clientID,
      environment.clientSecret,
    )
    return configuration
  }

  return {
    async authorizationURL(input) {
      const config = await getConfiguration()
      return oidc
        .buildAuthorizationUrl(config, {
          client_id: environment.clientID,
          code_challenge: input.pkceChallenge,
          code_challenge_method: 'S256',
          nonce: input.nonce,
          redirect_uri: environment.redirectURI,
          response_type: 'code',
          scope: REQUIRED_IDENTITY_SCOPES.join(' '),
          state: input.state,
        })
        .toString()
    },

    async exchangeCallback(input) {
      try {
        const config = await getConfiguration()
        const tokens = await oidc.authorizationCodeGrant(config, input.callbackURL, {
          expectedNonce: input.expectedNonce,
          expectedState: input.expectedState,
          idTokenExpected: true,
          pkceCodeVerifier: input.pkceVerifier,
        })

        if (typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0) {
          throw new IdentityIntegrationError(
            'refresh-token-rejected',
            'The Xero identity response unexpectedly included offline access.',
          )
        }
        if (typeof tokens.scope === 'string') validateIdentityScopes(tokens.scope)

        const claims = tokens.claims()
        if (!claims) {
          throw new IdentityIntegrationError(
            'missing-id-token',
            'Xero did not return a valid identity token.',
          )
        }

        const issuer = safeString(claims.iss, 500)
        const subject = safeString(claims.sub, 500)
        const email = safeString(claims.email, 320)?.toLowerCase() ?? null
        const issuedAt = claims.iat
        if (
          issuer !== XERO_IDENTITY_ISSUER ||
          !subject ||
          !email ||
          !emailPattern.test(email) ||
          claims.email_verified === false ||
          typeof issuedAt !== 'number' ||
          issuedAt > Math.floor(Date.now() / 1_000) + 60 ||
          issuedAt < Math.floor(Date.now() / 1_000) - 15 * 60
        ) {
          throw new IdentityIntegrationError(
            'invalid-identity-claims',
            'Xero returned incomplete identity claims.',
          )
        }

        const explicitName = safeString(claims.name, 200)
        const givenName = safeString(claims.given_name, 100)
        const familyName = safeString(claims.family_name, 100)
        const displayName =
          explicitName ??
          [givenName, familyName].filter(Boolean).join(' ').trim() ??
          email.split('@')[0]

        return { displayName: displayName || email, email, issuer, subject }
      } catch (error) {
        if (error instanceof IdentityIntegrationError) throw error
        throw new IdentityIntegrationError(
          'identity-callback-failed',
          'Xero sign-in could not be completed.',
          { cause: error },
        )
      }
    },
  }
}

export const createPKCEValues = async (): Promise<{
  nonce: string
  pkceChallenge: string
  pkceVerifier: string
  state: string
}> => {
  const pkceVerifier = oidc.randomPKCECodeVerifier()
  return {
    nonce: oidc.randomNonce(),
    pkceChallenge: await oidc.calculatePKCECodeChallenge(pkceVerifier),
    pkceVerifier,
    state: oidc.randomState(),
  }
}
