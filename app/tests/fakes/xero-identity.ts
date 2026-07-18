import { createHash, randomUUID } from 'node:crypto'

import {
  exportJWK,
  generateKeyPair,
  decodeProtectedHeader,
  jwtVerify,
  SignJWT,
  type JWK,
} from 'jose'

import type {
  IdentityAuthorizationInput,
  IdentityCallbackInput,
  XeroIdentityClient,
} from '@/lib/xero/identity/client'
import {
  IdentityIntegrationError,
  REQUIRED_IDENTITY_SCOPES,
  XERO_IDENTITY_ISSUER,
  validateIdentityScopes,
  type XeroIdentityClaims,
} from '@/lib/xero/identity/contracts'

type Key = { kid: string; privateKey: CryptoKey; publicJWK: JWK; publicKey: CryptoKey }

type CodeOptions = {
  claims?: Record<string, unknown>
  omitClaims?: string[]
  pkceVerifier: string
  scope?: string
}

type CodeRecord = {
  consumed: boolean
  input: IdentityAuthorizationInput
  scope: string
  token: string
}

const challenge = (verifier: string): string =>
  createHash('sha256').update(verifier, 'utf8').digest('base64url')

/** A controllable OIDC provider double with real JWT signing and JWKS rotation. */
export class FakeOIDCProvider {
  readonly audience: string
  readonly baseURL = 'https://fake-oidc.example.test'
  readonly issuer = XERO_IDENTITY_ISSUER

  outage = false

  private activeKey!: Key
  private authorization?: IdentityAuthorizationInput
  private codes = new Map<string, CodeRecord>()
  private keys = new Map<string, Key>()

  private constructor(audience: string) {
    this.audience = audience
  }

  static async create(audience = 'fake-identity-client'): Promise<FakeOIDCProvider> {
    const provider = new FakeOIDCProvider(audience)
    await provider.rotateSigningKey()
    return provider
  }

  discovery(): Record<string, unknown> {
    return {
      authorization_endpoint: `${this.baseURL}/authorize`,
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
      issuer: this.issuer,
      jwks_uri: `${this.baseURL}/jwks`,
      response_types_supported: ['code'],
      scopes_supported: [...REQUIRED_IDENTITY_SCOPES],
      token_endpoint: `${this.baseURL}/token`,
    }
  }

  jwks(): { keys: JWK[] } {
    return { keys: [...this.keys.values()].map((key) => structuredClone(key.publicJWK)) }
  }

  async rotateSigningKey(): Promise<string> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    const kid = randomUUID()
    const publicJWK = await exportJWK(publicKey)
    publicJWK.alg = 'RS256'
    publicJWK.kid = kid
    publicJWK.use = 'sig'
    const key = { kid, privateKey, publicJWK, publicKey }
    this.keys.set(kid, key)
    this.activeKey = key
    return kid
  }

  retireAllButActiveKey(): void {
    this.keys = new Map([[this.activeKey.kid, this.activeKey]])
  }

  async issueCode(options: CodeOptions): Promise<string> {
    if (!this.authorization) throw new Error('Start authorization before issuing a fake code.')
    if (challenge(options.pkceVerifier) !== this.authorization.pkceChallenge) {
      throw new Error('The fake PKCE verifier does not match the authorization challenge.')
    }
    const now = Math.floor(Date.now() / 1_000)
    const claims: Record<string, unknown> = {
      email: 'redacted.member@example.test',
      email_verified: true,
      name: 'Redacted Member',
      nonce: this.authorization.nonce,
      ...options.claims,
    }
    for (const name of options.omitClaims ?? []) delete claims[name]
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: this.activeKey.kid, typ: 'JWT' })
      .setAudience(this.audience)
      .setExpirationTime(now + 300)
      .setIssuedAt(now)
      .setIssuer(this.issuer)
      .setSubject(String(options.claims?.sub ?? 'fake-subject-1'))
      .sign(this.activeKey.privateKey)
    const code = randomUUID()
    this.codes.set(code, {
      consumed: false,
      input: structuredClone(this.authorization),
      scope: options.scope ?? REQUIRED_IDENTITY_SCOPES.join(' '),
      token,
    })
    return code
  }

  peekToken(code: string): string | undefined {
    return this.codes.get(code)?.token
  }

  client(): XeroIdentityClient {
    return {
      authorizationURL: async (input) => {
        if (this.outage) {
          throw new IdentityIntegrationError(
            'provider-unavailable',
            'The fake identity provider is unavailable.',
          )
        }
        this.authorization = structuredClone(input)
        const url = new URL('/authorize', this.baseURL)
        url.searchParams.set('client_id', this.audience)
        url.searchParams.set('code_challenge', input.pkceChallenge)
        url.searchParams.set('code_challenge_method', 'S256')
        url.searchParams.set('nonce', input.nonce)
        url.searchParams.set('scope', REQUIRED_IDENTITY_SCOPES.join(' '))
        url.searchParams.set('state', input.state)
        return url.toString()
      },
      exchangeCallback: async (input: IdentityCallbackInput): Promise<XeroIdentityClaims> => {
        if (this.outage) {
          throw new IdentityIntegrationError(
            'provider-unavailable',
            'The fake identity provider is unavailable.',
          )
        }
        if (input.callbackURL.searchParams.has('error')) {
          throw new IdentityIntegrationError('provider-error', 'The fake provider denied access.')
        }
        const code = input.callbackURL.searchParams.get('code')
        const state = input.callbackURL.searchParams.get('state')
        const record = code ? this.codes.get(code) : undefined
        if (!record || record.consumed) {
          throw new IdentityIntegrationError(
            'invalid-code',
            'The fake code is invalid or replayed.',
          )
        }
        if (
          state !== input.expectedState ||
          record.input.state !== input.expectedState ||
          challenge(input.pkceVerifier) !== record.input.pkceChallenge
        ) {
          throw new IdentityIntegrationError(
            'invalid-flow-binding',
            'The fake flow binding failed.',
          )
        }
        record.consumed = true
        validateIdentityScopes(record.scope)
        const header = decodeProtectedHeader(record.token)
        const key = typeof header.kid === 'string' ? this.keys.get(header.kid) : undefined
        if (!key)
          throw new IdentityIntegrationError('unknown-signing-key', 'The signing key is unknown.')
        const verified = await jwtVerify(record.token, key.publicKey, {
          audience: this.audience,
          issuer: this.issuer,
        })
        const claims = verified.payload
        if (
          claims.nonce !== input.expectedNonce ||
          typeof claims.sub !== 'string' ||
          typeof claims.email !== 'string' ||
          claims.email_verified === false
        ) {
          throw new IdentityIntegrationError(
            'invalid-claims',
            'The fake identity claims are invalid.',
          )
        }
        const displayName =
          typeof claims.name === 'string' && claims.name.trim()
            ? claims.name.trim()
            : claims.email.split('@')[0]!
        return {
          displayName,
          email: claims.email.toLowerCase(),
          issuer: String(claims.iss),
          subject: claims.sub,
        }
      },
    }
  }
}
