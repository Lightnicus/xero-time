// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { createPKCEValues } from '@/lib/xero/identity/client'
import {
  IdentityIntegrationError,
  REQUIRED_IDENTITY_SCOPES,
  validateIdentityScopes,
} from '@/lib/xero/identity/contracts'

describe('Xero identity trust boundary', () => {
  it('accepts exactly openid profile email', () => {
    expect(validateIdentityScopes('openid profile email')).toEqual(REQUIRED_IDENTITY_SCOPES)
  })

  it('rejects offline, accounting, missing, and expanded scopes', () => {
    for (const scopes of [
      'openid profile email offline_access',
      'openid profile email accounting.transactions',
      'openid profile',
      'openid profile email phone',
    ]) {
      expect(() => validateIdentityScopes(scopes)).toThrow(IdentityIntegrationError)
    }
  })

  it('creates independent high-entropy state, nonce, and PKCE values', async () => {
    const first = await createPKCEValues()
    const second = await createPKCEValues()
    expect(first.state).not.toBe(second.state)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.pkceVerifier).not.toBe(first.pkceChallenge)
    expect(first.pkceVerifier.length).toBeGreaterThanOrEqual(43)
    expect(first.pkceChallenge.length).toBeGreaterThanOrEqual(43)
  })
})
